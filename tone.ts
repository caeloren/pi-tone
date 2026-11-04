import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir, Theme, type ExtensionAPI, type ExtensionContext, type ThemeAppearance,
  type ThemeBg, type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { colorToHex, parseColor, rgbColor, backgroundAnsi as encodeBackground, foregroundAnsi as encodeForeground, type Terminal, type TUI } from "@earendil-works/pi-tui";

type Value = string | number;
type ColorMap = Record<string, Value>;
type Foregrounds = ConstructorParameters<typeof Theme>[0];
type Backgrounds = ConstructorParameters<typeof Theme>[1];
type ProgramStatusValue = Terminal extends { setProgramStatus(status: infer Status): void } ? Status : unknown;
interface Patch {
  appearance?: ThemeAppearance;
  colors: ColorMap;
  canvas?: CanvasSpec;
}
interface Baseline {
  fg: Foregrounds;
  bg: Backgrounds;
  dim: ThemeColor[];
  appearance: ThemeAppearance;
  mode: ReturnType<Theme["getColorMode"]>;
  name: string;
}
interface Candidate {
  name: string;
}
interface Diagnostic {
  message: string;
  name?: string;
  kind?: "user-directory";
}
type ThemeSource = "user" | "built-in";
interface PreparedTone {
  patch: Patch;
  source: ThemeSource;
}
type ApplyResult = { applied: true } | {
  applied: false;
  detail: string;
  nativeRecovery: boolean;
  reloadSafe: boolean;
};

const maximumBytes = 256 * 1024;
const foregroundAnsi = /^\x1b\[(?:39|38;5;(\d+)|38;2;(\d+);(\d+);(\d+))m(\x1b\[2m)?$/;
const backgroundAnsi = /^\x1b\[(?:49|48;5;(\d+)|48;2;(\d+);(\d+);(\d+))m$/;
const unsafeFilenameCharacters = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
// Bound individual display fields, not a composed cause/source/recovery message.
// Keep quoting and escapes intact; full logical names remain unchanged for matching.
function label(value: string): string {
  let text = '"';
  for (const character of value) {
    const escaped = unsafeFilenameCharacters.test(character)
      ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      : JSON.stringify(character).slice(1, -1);
    if (text.length + escaped.length + 4 > 240) return `${text}..."`;
    text += escaped;
  }
  return `${text}"`;
}

// Preserve source metadata separately, so long paths cannot displace the root cause.
class ToneReadError extends Error {
  constructor(readonly source: ThemeSource, readonly path: string | undefined, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Unexpected theme error.", { cause });
  }
}

function errorDetail(error: unknown, fallback: string): string {
  const detail = error instanceof Error ? label(error.message) : fallback;
  if (!(error instanceof ToneReadError)) return detail;
  return error.path === undefined
    ? `${detail} Source: built-in palette.`
    : `${detail} Source: ${error.source} theme ${label(error.path)}.`;
}

const maximumCanvasAxis = 8192;
const maximumCanvasCells = 1048576;
function validCanvasDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 1 && height >= 1
    && width <= maximumCanvasAxis && height <= maximumCanvasAxis && width * height <= maximumCanvasCells;
}

// Accepted, scoped exception: a reversible fullscreen output adapter, not a native canvas API.
// Pi remains responsible for layout, grapheme widths, images, selection and cursor placement.
// Completed native frames are prepainted before their text/images; no BCE is required.
interface CanvasSpec {
  background: Value;
  foreground?: Value;
}
interface CanvasAnsi {
  background: string;
  foreground: string;
}
function requireCanvasHost(tui: TUI): void {
  if (tui.mode !== "fullscreen" || typeof tui.renderNow !== "function" || typeof tui.requestRender !== "function") {
    throw new Error("This Tone requires a fullscreen canvas. Use Pi fullscreen mode, or select a JSON without canvas.");
  }
  const terminal = tui.terminal;
  if (!terminal || typeof terminal.write !== "function" || !validCanvasDimensions(terminal.columns, terminal.rows)) {
    throw new Error("Pi did not provide usable, bounded fullscreen dimensions.");
  }
}

interface FramePart {
  value: string;
  csi: boolean;
}

class CanvasTerminal implements Terminal {
  private state: "text" | "escape" | "csi" | "string" | "string-escape" = "text";
  private pending = "";
  private osc = false;
  private autoWrap = false; // Pi fullscreen disables autowrap before the adapter is installed.
  private alternate = true; // Installed only from a running fullscreen TUI.
  private stopped = false;
  private released = false;
  private inFrame = false;
  private frame: FramePart[] | undefined;
  private frameLength = 0;
  private foregroundDefault = true;
  private backgroundDefault = true;
  private paint: CanvasAnsi | undefined;
  private failure: Error | undefined;
  private wasEnabled = false;
  private completed = 0;
  private covered = false;

  // Limit buffered frames, including opaque graphics data. No unbounded CSI/image buffer.
  private static readonly maximumFrame = 16 * 1024 * 1024;
  private static readonly maximumParts = 262144;

  constructor(
    readonly original: Terminal,
    private readonly enabled: () => boolean,
    private readonly scopeLost: () => void,
    private readonly failed: (error: Error) => void,
  ) {}

  get columns(): number { return this.original.columns; }
  get rows(): number { return this.original.rows; }
  get kittyProtocolActive(): boolean { return this.original.kittyProtocolActive; }
  get atBoundary(): boolean { return this.state === "text" && !this.inFrame; }
  get error(): Error | undefined { return this.failure; }
  get paintedFrames(): number { return this.completed; }
  get fullGridPainted(): boolean { return this.covered; }

  configure(paint: CanvasAnsi | undefined): void {
    if (!this.atBoundary || this.released) throw new Error("A terminal frame is still pending; retry after rendering finishes.");
    this.paint = paint;
    this.failure = undefined;
    this.wasEnabled = paint !== undefined;
    this.covered = false;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.stopped = false;
    this.original.start(onInput, onResize);
  }
  stop(): void {
    this.flush();
    this.stopped = true;
    this.original.stop();
  }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.original.drainInput(maxMs, idleMs); }
  moveBy(lines: number): void { this.original.moveBy(lines); }
  hideCursor(): void { this.original.hideCursor(); }
  showCursor(): void { this.original.showCursor(); }
  clearLine(): void { this.original.clearLine(); }
  clearFromCursor(): void { this.original.clearFromCursor(); }
  clearScreen(): void { this.original.clearScreen(); }
  setTitle(title: string): void { this.original.setTitle(title); }
  setProgress(active: boolean): void { this.original.setProgress(active); }
  // Forward program status unchanged, once; Pi owns OSC 7501 detection and encoding.
  // Optional at runtime so hosts without this method remain tolerated.
  setProgramStatus(status: ProgramStatusValue): void {
    (this.original as Terminal & { setProgramStatus?: (value: ProgramStatusValue) => void }).setProgramStatus?.(status);
  }
  // Pi calls this from its exit handler when stop() did not run; the original Terminal owns the mode resets.
  // A partially buffered frame was never written, so there is nothing of ours to flush first.
  restoreOnExit(before: string, after: string): void {
    this.original.restoreOnExit?.(before, after);
  }

  release(): void {
    if (this.released) return;
    this.released = true; // A retained reference must be inert even if the sink throws.
    this.flush();
  }

  private flush(): void {
    const boundary = this.atBoundary;
    const raw = (this.frame?.map((part) => part.value).join("") ?? "") + this.pending;
    this.frame = undefined;
    this.pending = "";
    this.frameLength = 0;
    this.state = "text";
    this.inFrame = false;
    // Never put our reset inside a partially delivered OSC/DCS/APC or native frame.
    if (raw) this.original.write(raw);
    if (boundary) this.original.write("\x1b[39;49m");
  }

  private fault(message: string): void {
    if (this.failure) return;
    this.failure = new Error(message);
    this.failed(this.failure);
  }

  private defaults(): string {
    return (this.foregroundDefault ? this.paint?.foreground ?? "" : "")
      + (this.backgroundDefault ? this.paint?.background ?? "" : "");
  }

  private sgr(sequence: string): string {
    const parameters = sequence.slice(2, -1);
    if (!/^[0-9;:]*$/.test(parameters)) return sequence;
    let foregroundTouched = false;
    let backgroundTouched = false;
    const parts = parameters.split(";");
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? "";
      const colon = part.indexOf(":");
      const code = Number((colon === -1 ? part : part.slice(0, colon)) || "0");
      if (code === 0) {
        this.foregroundDefault = this.backgroundDefault = true;
        foregroundTouched = backgroundTouched = true;
      } else if (code === 39) {
        this.foregroundDefault = true;
        foregroundTouched = true;
      } else if (code === 49) {
        this.backgroundDefault = true;
        backgroundTouched = true;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97) || code === 38) {
        this.foregroundDefault = false;
        foregroundTouched = true;
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 48) {
        this.backgroundDefault = false;
        backgroundTouched = true;
      }
      // Skip color operands, including zero-valued channels and SGR 58 underline color.
      if ((code === 38 || code === 48 || code === 58) && colon === -1) {
        if (parts[i + 1] === "2") i += 4;
        else if (parts[i + 1] === "5") i += 2;
      }
    }
    // Bold/italic/faint/etc. never trigger redundant foreground/background output.
    return sequence
      + (foregroundTouched && this.foregroundDefault ? this.paint?.foreground ?? "" : "")
      + (backgroundTouched && this.backgroundDefault ? this.paint?.background ?? "" : "");
  }

  private paintFrame(parts: readonly FramePart[]): string {
    if (this.autoWrap) throw new Error("Canvas requires Pi fullscreen autowrap to remain disabled.");
    const width = this.columns;
    const height = this.rows;
    if (!validCanvasDimensions(width, height)) {
      throw new Error("Unsupported fullscreen dimensions for canvas painting.");
    }
    const rows = new Set<number>();
    const erase = new Set<number>();
    let firstRow = -1;
    let screenClear = false;
    // Recognize only the reference native renderer's CUP(row,1)+EL(2) row contract.
    // We do not estimate text width or emulate arbitrary cursor movement.
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part?.csi) continue;
      const final = part.value.slice(-1);
      if (final === "J") {
        if (part.value !== "\x1b[2J" || firstRow !== -1) {
          throw new Error("Unsupported erase-display order in a canvas frame.");
        }
        screenClear = true;
      } else if (final === "K") {
        const previous = parts[i - 1];
        const position = previous?.csi ? /^\x1b\[([1-9][0-9]*);1H$/.exec(previous.value) : null;
        const row = Number(position?.[1]);
        if (part.value !== "\x1b[2K" || !position || row > height || rows.has(row)) {
          throw new Error("Unsupported native row erase in a canvas frame.");
        }
        if (firstRow === -1) firstRow = i - 1;
        rows.add(row);
        erase.add(i);
      } else if (/^[LMSTr]$/.test(final) || (/[hl]/.test(final) && /^\x1b\[\?(?:.*;)?(?:6|7)(?:;|[hl])/.test(part.value))) {
        throw new Error("Unsupported scrolling or terminal-mode change in a canvas frame.");
      }
    }
    if (screenClear && firstRow === -1) throw new Error("A cleared canvas frame did not provide native row positions.");
    if (screenClear) for (let row = 1; row <= height; row += 1) rows.add(row);
    this.foregroundDefault = this.backgroundDefault = true;
    const output: string[] = [];
    const prefixStyles: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part) continue;
      if (i === firstRow) {
        // All native clears are handled BEFORE any row text or image placement.
        // Explicit spaces work with and without BCE. Pi fullscreen disables autowrap;
        // CUP before the original row content leaves cursor registers untouched.
        const spaces = " ".repeat(width);
        output.push("\x1b[0m", this.paint?.background ?? "");
        for (const row of [...rows].sort((a, b) => a - b)) output.push(`\x1b[${row};1H`, spaces);
        output.push("\x1b[0m", ...prefixStyles, this.defaults());
      }
      if (erase.has(i)) continue; // A later EL would punch a hole on non-BCE terminals.
      if (part.csi && part.value.endsWith("m")) {
        const styled = this.sgr(part.value);
        output.push(styled);
        if (firstRow !== -1 && i < firstRow) prefixStyles.push(styled);
      } else {
        output.push(part.value);
        if (i === 0) output.push(this.defaults());
      }
    }
    // Full native frames leave row attributes reset; only restore our default channels.
    output.splice(output.length - 1, 0, "\x1b[39;49m");
    this.covered = rows.size === height;
    this.completed += 1;
    return output.join("");
  }

  private accept(value: string, csi: boolean, output: string[]): void {
    if (csi && value === "\x1b[?7h") {
      this.autoWrap = true;
      // Pi's normal pre-stop frame enables autowrap before returning to the shell.
      // Forward transition frames, rather than treating orderly suspension as a fault.
      if (this.frame) {
        for (const part of this.frame) output.push(part.value);
        this.frame = undefined;
        this.frameLength = 0;
      }
      output.push("\x1b[39;49m", value);
      return;
    }
    if (csi && value === "\x1b[?7l") this.autoWrap = false;
    const alternate = csi ? /^\x1b\[\?(?:47|1047|1049)([hl])$/.exec(value) : null;
    if (alternate) {
      this.alternate = alternate[1] === "h";
      // Never decorate alt-screen exit/main-screen transcript replay frames.
      if (this.frame) {
        for (const part of this.frame) output.push(part.value);
        this.frame = undefined;
        this.frameLength = 0;
      }
      output.push("\x1b[39;49m", value);
      return;
    }
    if (csi && value === "\x1b[?2026h") {
      if (this.inFrame) {
        this.fault("Nested synchronized frames are not supported by the canvas adapter.");
        if (this.frame) for (const part of this.frame) output.push(part.value);
        this.frame = undefined;
      }
      this.inFrame = true;
      const enabled = !this.failure && !this.stopped && this.alternate && !!this.paint && this.enabled();
      if (this.wasEnabled && !enabled && !this.stopped && this.alternate && !this.failure) this.scopeLost();
      this.wasEnabled = enabled;
      if (enabled) { this.frame = []; this.frameLength = 0; }
    }
    if (this.frame) {
      this.frame.push({ value, csi });
      this.frameLength += value.length;
      if (this.frameLength > CanvasTerminal.maximumFrame || this.frame.length > CanvasTerminal.maximumParts) {
        this.fault("A canvas frame exceeded the bounded parser limit; native output was preserved.");
        for (const part of this.frame) output.push(part.value);
        this.frame = undefined;
        this.frameLength = 0;
      } else if (csi && value === "\x1b[?2026l") {
        const parts = this.frame;
        this.frame = undefined;
        this.frameLength = 0;
        try {
          if (this.failure) throw this.failure;
          output.push(this.paintFrame(parts));
        } catch (error) {
          for (const part of parts) output.push(part.value);
          this.fault(error instanceof Error ? error.message : "Could not paint a native canvas frame.");
        }
      }
    } else output.push(value);
    if (csi && value === "\x1b[?2026l") this.inFrame = false;
  }

  write(data: string): void {
    if (this.released) { this.original.write(data); return; }
    const output: string[] = [];
    let index = 0;
    while (index < data.length) {
      if (this.state === "text") {
        const next = data.indexOf("\x1b", index);
        if (next === -1) { this.accept(data.slice(index), false, output); break; }
        if (next > index) this.accept(data.slice(index, next), false, output);
        this.pending = "\x1b";
        this.state = "escape";
        index = next + 1;
      } else if (this.state === "escape") {
        const char = data.charAt(index++);
        this.pending += char;
        if (char === "[") this.state = "csi";
        else {
          this.accept(this.pending, false, output);
          this.pending = "";
          this.osc = char === "]";
          this.state = "]P_^X".includes(char) ? "string" : "text";
        }
      } else if (this.state === "csi") {
        const char = data.charAt(index++);
        this.pending += char;
        if (char >= "@" && char <= "~") {
          this.accept(this.pending, true, output);
          this.pending = "";
          this.state = "text";
        } else if (this.pending.length > 128 || char < " " || char > "?") {
          this.accept(this.pending, false, output);
          this.pending = "";
          this.state = "text";
          if (this.frame) this.fault("Malformed control sequence in a canvas frame.");
        }
      } else if (this.state === "string-escape") {
        const char = data.charAt(index++);
        this.accept(char, false, output);
        this.state = char === "\\" ? "text" : char === "\x1b" ? "string-escape" : "string";
      } else {
        // OSC/DCS/APC are opaque: embedded SGR or frame markers are never interpreted.
        const escape = data.indexOf("\x1b", index);
        const bell = this.osc ? data.indexOf("\x07", index) : -1;
        const end = escape < 0 ? bell : bell < 0 ? escape : Math.min(escape, bell);
        if (end < 0) { this.accept(data.slice(index), false, output); break; }
        this.accept(data.slice(index, end + 1), false, output);
        this.state = end === bell ? "text" : "string-escape";
        index = end + 1;
      }
    }
    if (output.length) this.original.write(output.join(""));
  }
}

function parseCanvas(document: Record<string, unknown>, resolve: (value: unknown) => Value): CanvasSpec | undefined {
  if (!Object.hasOwn(document, "canvas")) return undefined;
  const canvas = object(document["canvas"], "canvas");
  if (!Object.hasOwn(canvas, "background")) throw new Error("canvas.background is required when canvas is present.");
  for (const key of Object.keys(canvas)) {
    if (key !== "background" && key !== "foreground") throw new Error(`Unknown canvas property: ${label(key)}.`);
  }
  const background = resolve(canvas["background"]);
  const foreground = Object.hasOwn(canvas, "foreground") ? resolve(canvas["foreground"]) : undefined;
  // A canvas requests explicit painting; omit canvas to leave terminal defaults alone.
  if (background === "" || foreground === "") throw new Error("Canvas colors must be explicit colors, not terminal defaults.");
  return { background, ...(foreground === undefined ? {} : { foreground }) };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

// Configuration is data only. Bound reads and reject nonregular files and symlinks.
function readBytes(fd: number, limit: number): Buffer {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > limit) {
    throw new Error(`Expected a regular JSON file of at most ${limit} bytes.`);
  }
  const buffer = Buffer.alloc(stat.size + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = readSync(fd, buffer, size, buffer.length - size, size);
    if (count === 0) break;
    size += count;
  }
  if (size !== stat.size) throw new Error("The JSON file changed while being read. Retry the command.");
  return buffer.subarray(0, size);
}

function readDocument(path: string, limit = maximumBytes): Record<string, unknown> {
  if (realpathSync(path) !== path) throw new Error("JSON files must not be symbolic links.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBytes(fd, limit)));
    return object(value, "JSON");
  } finally {
    closeSync(fd);
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// One permanent preference, outside the installed package. Never store colors or a theme copy.
const preferenceLimit = 4096;
function preferencePath(): string {
  return join(realpathSync(getAgentDir()), "pi-tone.json");
}

function readPreference(): string | undefined {
  let path: string;
  try {
    path = preferencePath();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("Pi Tone preferences must be a regular file, not a link.");
    }
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const document = readDocument(path, preferenceLimit);
  const tone = document["tone"];
  if (Object.keys(document).length !== 1 || typeof tone !== "string") {
    throw new Error('Pi Tone preferences must contain only a valid "tone" filename without .json.');
  }
  // Validate the logical name when resolving the saved choice, so its discovery
  // diagnostic and restoration failure can be reported together without duplication.
  return tone;
}

function writeBytes(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error("Could not finish writing Pi Tone preferences.");
    offset += count;
  }
  ftruncateSync(fd, bytes.length);
  fsyncSync(fd);
}

function savePreference(name: string): void {
  const bytes = Buffer.from(`${JSON.stringify({ tone: name }, null, 2)}\n`, "utf8");
  if (bytes.length > preferenceLimit) throw new Error("The Tone name is too long to save.");
  mkdirSync(getAgentDir(), { recursive: true, mode: 0o700 });
  const path = preferencePath();
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path);
    if (!existing.isFile() || existing.nlink !== 1) {
      throw new Error("Pi Tone preferences must be a regular file, not a link.");
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const flags = constants.O_RDWR | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags | (existing ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 ||
        (existing && (stat.dev !== existing.dev || stat.ino !== existing.ino)) || realpathSync(path) !== path) {
      throw new Error("The Pi Tone preference file changed or is unsafe. Retry the command.");
    }
    const previous = readBytes(fd, preferenceLimit);
    if (previous.equals(bytes)) return;
    // Direct write: no temporary file. Restore previous bytes on a recoverable write failure.
    try {
      writeBytes(fd, bytes);
    } catch (error) {
      try { writeBytes(fd, previous); } catch {
        throw new Error("Could not save or restore Pi Tone preferences. Check pi-tone.json before restarting Pi.");
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

// Remove only our fixed preference path. Missing or malformed JSON needs no replacement file.
function clearPreference(): void {
  try {
    const path = preferencePath();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== path) {
      throw new Error("Pi Tone preferences must be a regular file, not a link.");
    }
    unlinkSync(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function resolver(document: Record<string, unknown>): (value: unknown) => Value {
  const vars = document["vars"] === undefined ? {} : object(document["vars"], "vars");
  const cache = new Map<string, Value>();
  function resolve(value: unknown): Value {
    const chain = new Set<string>();
    while (typeof value === "string" && value !== "" && !value.startsWith("#") && !/^ok(lch|hsl)\(/i.test(value)) {
      const cached = cache.get(value);
      if (cached !== undefined) { value = cached; break; }
      if (!Object.hasOwn(vars, value) || chain.has(value)) {
        throw new Error(`Missing or circular color variable: ${label(value)}.`);
      }
      chain.add(value);
      value = vars[value];
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error("Colors must be strings or palette indices.");
    }
    if (value !== "") parseColor(value);
    for (const name of chain) cache.set(name, value);
    return value;
  }
  for (const name of Object.keys(vars)) resolve(vars[name]);
  return resolve;
}

function colorMap(document: Record<string, unknown>, key: string, resolve: (value: unknown) => Value): ColorMap {
  const values = document[key] === undefined ? {} : object(document[key], key);
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, resolve(value)]));
}

function parsePatch(document: Record<string, unknown>, name: string): Patch {
  if (Object.hasOwn(document, "export")) {
    throw new Error("export is not supported. Pi Tone only overrides terminal colors.");
  }
  for (const key of Object.keys(document)) {
    if (!["$schema", "name", "appearance", "vars", "colors", "canvas"].includes(key)) {
      throw new Error(`Unknown theme property: ${label(key)}.`);
    }
  }
  if (document["name"] !== name) throw new Error("The theme name must match the filename without .json.");
  if (document["$schema"] !== undefined && typeof document["$schema"] !== "string") {
    throw new Error("$schema must be a string.");
  }
  const appearance = document["appearance"];
  if (appearance !== undefined && appearance !== "dark" && appearance !== "light") {
    throw new Error('appearance must be "dark" or "light".');
  }
  const resolve = resolver(document);
  const colors = colorMap(document, "colors", resolve);
  const canvas = parseCanvas(document, resolve);
  return { colors, ...(appearance === undefined ? {} : { appearance }), ...(canvas === undefined ? {} : { canvas }) };
}

// Preserve the original rendered colors, terminal defaults, ANSI indices, and faint flags.
// Unsupported future representations fail before applying anything rather than guessing.
function ansiColor(ansi: string, background: boolean): { value: Value; dim: boolean } {
  const match = (background ? backgroundAnsi : foregroundAnsi).exec(ansi);
  if (!match) throw new Error("This Pi version uses an unsupported theme color representation.");
  let value: Value = "";
  if (match[1] !== undefined) value = Number(match[1]);
  if (match[2] !== undefined) {
    value = colorToHex(rgbColor(Number(match[2]), Number(match[3]), Number(match[4])));
  }
  return { value, dim: match[5] !== undefined };
}

function snapshot(ctx: ExtensionContext): Baseline {
  const theme = ctx.ui.theme;
  const fg: ColorMap = {};
  const bg: ColorMap = {};
  const dim: ThemeColor[] = [];
  for (const token of Object.keys(theme.colors)) {
    // Keys come from Pi. Its public accessors validate which slot each token belongs to.
    let ansi: string;
    let background = false;
    try {
      ansi = theme.getFgAnsi(token as ThemeColor);
    } catch {
      ansi = theme.getBgAnsi(token as ThemeBg);
      background = true;
    }
    const color = ansiColor(ansi, background);
    Object.defineProperty(background ? bg : fg, token, {
      value: color.value, enumerable: true, writable: true, configurable: true,
    });
    if (color.dim && !background) dim.push(token as ThemeColor);
  }
  // A loadable native name keeps /export working without files or settings changes.
  const name = theme.name;
  return {
    fg: fg as Foregrounds, bg: bg as Backgrounds, dim,
    appearance: theme.appearance, mode: theme.getColorMode(),
    name: name && ctx.ui.getTheme(name) ? name : "system",
  };
}

function merge(base: Baseline, patch: Patch): Theme {
  const fg: ColorMap = { ...base.fg };
  const bg: ColorMap = { ...base.bg };
  for (const [key, value] of Object.entries(patch.colors)) {
    if (Object.hasOwn(fg, key)) fg[key] = value;
    else if (Object.hasOwn(bg, key)) bg[key] = value;
    else throw new Error(`Unknown color in this Pi version: ${label(key)}.`);
  }
  // All original slots are present, including optional and future runtime tokens.
  return new Theme(fg as Foregrounds, bg as Backgrounds, base.mode, {
    name: base.name, appearance: patch.appearance ?? base.appearance,
    dim: base.dim.filter((key) => !Object.hasOwn(patch.colors, key)),
  });
}

// Sixteen built-in palettes, kept as data in this program. Each one becomes a complete Tone document
// (G0-G4 variables, every role, canvas G0/G4) and passes through the same parser as user files.
type Shade = "G0" | "G1" | "G2" | "G3" | "G4";
const shades = ["G0", "G1", "G2", "G3", "G4"] as const;
// One role map for all sixteen palettes.
const sharedRoles: Readonly<Record<Shade, readonly string[]>> = {
  G0: ["searchMatchBg"],
  G1: ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"],
  G2: ["border", "borderMuted", "scrollbarTrack", "mdQuoteBorder", "mdHr", "toolDiffRemoved", "syntaxComment"],
  G3: ["accent", "success", "muted", "dim", "thinkingText", "customMessageText", "toolOutput", "mdLinkUrl",
    "mdCodeBlockBorder", "mdQuote", "toolDiffContext", "syntaxString", "syntaxNumber", "syntaxOperator",
    "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow"],
  G4: ["borderAccent", "error", "warning", "text", "scrollbarThumb", "searchMatchText", "userMessageText",
    "customMessageLabel", "toolTitle", "mdHeading", "mdLink", "mdCode", "mdCodeBlock", "mdListBullet", "toolDiffAdded",
    "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxType", "thinkingMedium", "thinkingHigh",
    "thinkingXhigh", "thinkingMax", "bashMode"],
};
// G0-G4 per palette. These values are fixed by the design and must not be adjusted. Each light palette's G0-to-G1
// step in OKLCH lightness matches its dark counterpart's (light with dark, red-light with red-dark, and so on).
const builtInPalettes = new Map<string, readonly [string, string, string, string, string]>([
  ["dark", ["#101010", "#1C1C1C", "#727272", "#A6A6A6", "#FAFAFA"]],
  ["light", ["#FAFAFA", "#E8E8E8", "#7D7D7D", "#4F4F4F", "#101010"]],
  ["red-dark", ["#1E1312", "#332120", "#B6918D", "#DABCB9", "#FBEAE8"]],
  ["red-light", ["#FFF2F0", "#F0D8D6", "#7B5956", "#5A3E3B", "#291918"]],
  ["orange-dark", ["#1C140D", "#302418", "#AF967F", "#D5C0AD", "#F7ECE2"]],
  ["orange-light", ["#FCF3EC", "#EADACC", "#755E48", "#56422F", "#261C11"]],
  ["yellow-dark", ["#18160D", "#292717", "#A19C7D", "#C9C5AC", "#F1EFE2"]],
  ["yellow-light", ["#F7F6EB", "#E2DFCC", "#696446", "#4B472E", "#211E10"]],
  ["green-dark", ["#101812", "#1D2A1F", "#88A48D", "#B5CBB8", "#E6F2E8"]],
  ["green-light", ["#EFF8F0", "#D2E3D5", "#516B56", "#374D3B", "#162118"]],
  ["blue-dark", ["#0F171D", "#1A2832", "#83A0B5", "#B1C8D9", "#E4F0FA"]],
  ["blue-light", ["#EDF7FE", "#D0E1EF", "#4C677B", "#32495A", "#132029"]],
  ["indigo-dark", ["#14151E", "#222534", "#939AB8", "#BDC3DB", "#EBEEFB"]],
  ["indigo-light", ["#F2F5FF", "#D9DEF1", "#5B627D", "#40455C", "#1A1D2A"]],
  ["purple-dark", ["#19141C", "#2A2330", "#A494B1", "#CBBED6", "#F2EBF8"]],
  ["purple-light", ["#F8F3FC", "#E4DAEC", "#6B5C77", "#4D4057", "#221B27"]],
]);

function builtInDocument(name: string): Record<string, unknown> | undefined {
  const values = builtInPalettes.get(name);
  if (values === undefined) return undefined;
  const colors: Record<string, Shade> = {};
  for (const shade of shades) for (const role of sharedRoles[shade]) colors[role] = shade;
  return {
    name, appearance: name.endsWith("light") ? "light" : "dark",
    vars: { G0: values[0], G1: values[1], G2: values[2], G3: values[3], G4: values[4] }, colors,
    canvas: { background: "G0", foreground: "G4" },
  };
}

function commandParts(name: string): { command: string; args: string } {
  const space = name.indexOf(" ");
  return space === -1
    ? { command: `tone-${name}`, args: "" }
    : { command: `tone-${name.slice(0, space)}`, args: name.slice(space + 1) };
}

function filenameError(filename: string): string | undefined {
  const name = filename.slice(0, -5);
  if (name === "") return "a theme filename must contain text before .json.";
  if (name.includes("@")) return '"@" is not allowed in Tone filenames because it can conflict with Pi file-reference completion.';
  if (name.startsWith(".")) return "hidden theme files are not supported.";
  if (name.includes(".")) return "do not place another period before .json.";
  if (/[\/\\]/u.test(name)) return "path separators are not allowed in a theme filename.";
  if (name.trim().length === 0) return "a theme filename must contain visible text before .json.";
  if (name.trimEnd() !== name) return "trailing whitespace is not supported by Pi slash commands.";
  if (unsafeFilenameCharacters.test(name)) return "control or bidirectional formatting characters are not supported.";
  return undefined;
}

// Use the same filename rules at discovery, preference restore, and application boundaries.
function requireToneName(name: string): void {
  const problem = filenameError(`${name}.json`);
  if (problem !== undefined) throw new Error(`${problem} Invalid Tone filename: ${label(`${name}.json`)}.`);
}

// User-owned data stays outside the replaceable package. Discovery never creates directories.
function directoryIfPresent(path: string): string | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`Expected a real directory, not a file or link: ${label(path)}.`);
  }
  return path;
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function userThemeDirectory(): string | undefined {
  const packageRoot = realpathSync(fileURLToPath(new URL("./", import.meta.url)));
  let agent: string;
  try { agent = realpathSync(getAgentDir()); } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const userRoot = join(agent, "pi-tone");
  const directory = join(userRoot, "themes");
  // Package updates may clean the package tree, so it must never contain or sit inside user data.
  if (containsPath(packageRoot, directory) || containsPath(directory, packageRoot)) {
    throw new Error("Pi Tone must not be installed inside its user themes directory or in a directory that contains it.");
  }
  if (directoryIfPresent(userRoot) === undefined) return undefined;
  return directoryIfPresent(directory);
}

function usages(candidates: ReadonlyMap<string, Candidate>): string {
  const values = [...candidates.values()];
  const shown = values.slice(0, 5).map(({ name }) => `/tone-${name}`).join(", ");
  return values.length > 5 ? `${shown}, and ${values.length - 5} more` : shown;
}

export default function (pi: ExtensionAPI): void {
  const warnings: Diagnostic[] = [];
  const groups = new Map<string, Map<string, Candidate>>();
  const byName = new Map<string, Candidate>();
  let baseline: Baseline | undefined;
  let active: Theme | undefined;
  let holdingTheme: Theme | undefined;
  let cancelDeferredRestore: (() => void) | undefined;
  let nativeReady: Promise<boolean> | undefined;
  let selectionGeneration = 0;
  // A Theme object restores colors, not Pi's native watcher/appearance controller.
  // Keep this obligation until a native lifecycle reset or a successful new Tone.
  let nativeRecoveryRequired = false;
  let userDiscoveryError: string | undefined;

  const canvasKey = "pi-tone:canvas";
  interface CanvasState { owner: Theme; paint: CanvasAnsi }
  interface CanvasBinding {
    tui: TUI;
    adapter: CanvasTerminal;
    ctx: ExtensionContext;
    state: CanvasState | undefined;
    live: boolean;
    detach: () => void;
  }
  let canvasBinding: CanvasBinding | undefined;

  function clearCanvas(redraw = true): void {
    const binding = canvasBinding;
    if (!binding) return;
    canvasBinding = undefined;
    try { binding.detach(); } finally {
      try { binding.ctx.ui.setWidget(canvasKey, undefined, { placement: "belowEditor" }); } finally {
        if (redraw) binding.tui.requestRender(true);
      }
    }
  }

  function acquireCanvas(ctx: ExtensionContext): CanvasBinding {
    if (canvasBinding) {
      requireCanvasHost(canvasBinding.tui);
      if (!canvasBinding.live || canvasBinding.tui.terminal !== canvasBinding.adapter) {
        throw new Error("Another extension replaced the canvas output. Run /tone-off or /reload before enabling a canvas again.");
      }
      if (!canvasBinding.adapter.atBoundary) throw new Error("A terminal frame is pending. Retry the Tone after it completes.");
      return canvasBinding;
    }
    try {
      ctx.ui.setWidget(canvasKey, (tui: TUI) => {
        requireCanvasHost(tui);
        const original = tui.terminal;
        const adapter: CanvasTerminal = new CanvasTerminal(original, (): boolean => {
          const binding = canvasBinding;
          return binding !== undefined && binding.adapter === adapter && binding.live && binding.state !== undefined
            && tui.terminal === adapter && tui.mode === "fullscreen"
            && ctx.ui.theme.colors === binding.state.owner.colors;
        }, () => {
          const state = canvasBinding?.state;
          queueMicrotask(() => {
            if (!canvasBinding || canvasBinding.adapter !== adapter || canvasBinding.state !== state || !state ||
                (tui.terminal === adapter && ctx.ui.theme.colors === state.owner.colors)) return;
            // A later owner wins. Retained decorator references become transparent.
            try { clearCanvas(); } catch {
              ctx.ui.notify("Pi Tone could not finish canvas cleanup. Retry /reload.", "warning");
            }
          });
        }, (error) => {
          queueMicrotask(() => {
            const binding = canvasBinding;
            // A synchronous activation rollback clears this error before this task runs.
            if (!binding || binding.adapter !== adapter || adapter.error !== error || !binding.live) return;
            const owns = binding.state !== undefined && ctx.ui.theme.colors === binding.state.owner.colors;
            let recovery = "Canvas output was disabled; the saved choice was not changed. Retry /reload.";
            try {
              clearCanvas(false);
              if (owns && baseline && active) {
                replaceTheme(merge(baseline, { colors: {} }), active, baseline, ctx);
                nativeRecoveryRequired = true;
                recovery = "Pi baseline colors were restored, but native theme management still needs /reload. The saved choice is unchanged and may be retried; /tone-off clears it and requests native recovery.";
              }
              if (tui.terminal === original) tui.renderNow(true);
            } catch { recovery = "Canvas recovery also failed. Retry /reload before continuing."; }
            ctx.ui.notify(`Pi Tone: ${error.message} ${recovery}`, "warning");
          });
        });
        const binding: CanvasBinding = {
          tui, adapter, ctx, state: undefined, live: true,
          detach: () => {
            if (!binding.live) return;
            binding.live = false;
            if (canvasBinding === binding) canvasBinding = undefined;
            try { adapter.release(); } finally {
              // Never overwrite a newer terminal decorator installed by someone else.
              if (tui.terminal === adapter) tui.terminal = original;
            }
          },
        };
        canvasBinding = binding;
        tui.terminal = adapter;
        if (tui.terminal !== adapter) throw new Error("Pi did not accept the fullscreen canvas adapter.");
        return { render: () => [], invalidate: () => {}, dispose: binding.detach };
      }, { placement: "belowEditor" });
      if (!canvasBinding) throw new Error("Pi did not synchronously create the canvas component.");
      return canvasBinding;
    } catch (error) {
      try { clearCanvas(); } catch {
        throw new Error("Canvas preparation and cleanup failed. Run /reload before continuing.");
      }
      throw error;
    }
  }

  function configureCanvas(binding: CanvasBinding, state: CanvasState | undefined): void {
    if (!binding.live || binding.tui.terminal !== binding.adapter) {
      throw new Error("Canvas output ownership changed during selection.");
    }
    binding.adapter.configure(state?.paint);
    binding.state = state;
  }

  function drawCanvas(binding: CanvasBinding, requireCanvas: boolean): void {
    const count = binding.adapter.paintedFrames;
    binding.tui.renderNow(true);
    if (requireCanvas && (binding.adapter.error || binding.adapter.paintedFrames === count || !binding.adapter.fullGridPainted)) {
      throw binding.adapter.error ?? new Error("Pi did not produce a complete supported fullscreen canvas frame.");
    }
  }

  // Resolve the logical name again for every application. A present user entry owns the
  // name even when unreadable/invalid; only absence permits the built-in fallback.
  function readTone(candidate: Candidate): PreparedTone {
    requireToneName(candidate.name);
    if (userDiscoveryError !== undefined) {
      throw new Error(`${userDiscoveryError} Fix the user directory and run /reload.`);
    }
    const directory = userThemeDirectory();
    if (directory !== undefined) {
      const path = join(directory, `${candidate.name}.json`);
      let stat: ReturnType<typeof lstatSync> | undefined;
      try { stat = lstatSync(path); } catch (error) {
        if (!missing(error)) throw new ToneReadError("user", path, error);
      }
      if (stat !== undefined) {
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new ToneReadError("user", path, new Error("Expected a regular JSON file, not a link."));
        }
        try {
          return { patch: parsePatch(readDocument(path), candidate.name), source: "user" };
        } catch (error) {
          throw new ToneReadError("user", path, error);
        }
      }
    }
    const document = builtInDocument(candidate.name);
    if (document === undefined) {
      throw new Error("The selected Tone is neither in the user themes directory nor built in. Restore the file or run /reload.");
    }
    try {
      return { patch: parsePatch(document, candidate.name), source: "built-in" };
    } catch (error) {
      throw new ToneReadError("built-in", undefined, error);
    }
  }

  function cancelRestore(): void {
    selectionGeneration += 1;
    const cancel = cancelDeferredRestore;
    cancelDeferredRestore = undefined;
    cancel?.();
  }

  function replaceTheme(next: Theme, previous: Theme, base: Baseline, ctx: ExtensionContext): void {
    // Mark BEFORE invoking the host: it can disable native management and then fail
    // without replacing any visible colors. Color-map equality cannot prove rollback.
    if (active === undefined || ctx.ui.theme.colors !== active.colors) nativeRecoveryRequired = true;
    try {
      // Pass a Theme object: the string overload persists the user's theme setting.
      const result = ctx.ui.setTheme(next);
      if (!result.success) throw new Error(result.error || "Pi could not apply the theme.");
    } catch (error) {
      if (ctx.ui.theme.colors === next.colors) {
        try {
          if (!ctx.ui.setTheme(previous).success) throw new Error("Restore failed.");
        } catch {
          if (ctx.ui.theme.colors === next.colors) {
            baseline = base;
            active = next;
          } else if (ctx.ui.theme.colors === previous.colors) {
            baseline = base;
            active = previous;
          } else {
            baseline = undefined;
            active = undefined;
          }
          throw new Error("Pi failed while applying or restoring the theme. Run /reload before continuing.");
        }
        // The restored object may be a snapshot rather than the original proxy.
        baseline = base;
        active = previous;
      }
      throw error;
    }
    baseline = base;
    active = next;
  }

  function reportApplyFailure(candidate: Candidate, ctx: ExtensionContext, restoring: boolean,
      result: Extract<ApplyResult, { applied: false }>, reloading = false): void {
    if (ctx.mode !== "tui") return;
    // Recovery guidance must not be truncated with the possibly long underlying error.
    const recovery = !result.nativeRecovery ? "" : reloading
      ? " The new choice was not saved. Requesting Pi's native /reload to restore theme management. If Pi cannot finish, resolve its error and retry /reload."
      : " Native theme management has not been confirmed restored. When Pi is idle, run /reload. The saved choice is unchanged and may be retried; /tone-off clears it and requests native recovery.";
    ctx.ui.notify((restoring
      ? "Pi Tone: Could not restore the saved Tone: "
      : "Could not apply Tone: ") + result.detail + ` Tone: ${label(candidate.name)}.` + recovery,
      restoring ? "warning" : "error");
  }

  function apply(candidate: Candidate, ctx: ExtensionContext, restoring: boolean, prepared?: PreparedTone): ApplyResult {
    const { name } = candidate;
    if (ctx.mode !== "tui") return { applied: false, detail: "TUI mode is required.", nativeRecovery: false, reloadSafe: false };
    if (typeof ctx.ui.getTheme !== "function" || typeof ctx.ui.setTheme !== "function") {
      return { applied: false, detail: "Pi Tone requires an interactive terminal with theme support.", nativeRecovery: false, reloadSafe: false };
    }
    let reloadSafe = false;
    try {
      requireToneName(name);
      const { patch, source } = prepared ?? readTone(candidate);
      const ownTheme = active !== undefined && ctx.ui.theme.colors === active.colors;
      const empty = Object.keys(patch.colors).length === 0 && patch.canvas === undefined;
      if (empty && (!ownTheme || !baseline)) {
        clearCanvas();
        if (!restoring) ctx.ui.notify(nativeRecoveryRequired
          ? "No color changes were requested. Native theme management still needs /reload."
          : "No terminal colors were specified. The current Pi theme was not changed.", "info");
        return { applied: true };
      }
      const base = ownTheme && baseline ? baseline : snapshot(ctx);
      const next = merge(base, empty ? { colors: {} } : patch);
      const previous = ownTheme && active ? active : merge(base, { colors: {} });
      const previousColors = ctx.ui.theme.colors;
      const previousBase = baseline;
      const previousActive = active;
      const oldBinding = canvasBinding;
      const oldState = oldBinding?.state;
      // Validate/encode before changing either visual channel. Omitted canvas means no
      // canvas, not the preceding Tone's state and not the shadowed built-in palette.
      const paint: CanvasAnsi | undefined = patch.canvas === undefined ? undefined : {
        background: encodeBackground(parseColor(patch.canvas.background), next.getColorMode()),
        foreground: patch.canvas.foreground === undefined ? "" : encodeForeground(parseColor(patch.canvas.foreground), next.getColorMode()),
      };
      // A rejected mode/widget/terminal capability leaves the old role theme untouched.
      const binding = paint ? acquireCanvas(ctx) : canvasBinding;
      try {
        if (binding) configureCanvas(binding, paint ? { owner: next, paint } : undefined);
        replaceTheme(next, previous, base, ctx);
        if (binding) drawCanvas(binding, paint !== undefined);
        if (!paint) clearCanvas(false);
      } catch (error) {
        // Revert the whole visual selection; only the caller saves on true success.
        // This is an in-memory operation, not a cross-process preference transaction.
        try {
          const current = ctx.ui.theme.colors;
          if (current === next.colors) {
            const result = ctx.ui.setTheme(previous);
            if (!result.success) throw new Error("Pi rejected the previous theme.");
          } else if (current !== previousColors && current !== previous.colors) {
            throw new Error("A different theme took ownership during the failed selection.");
          }
          if (ctx.ui.theme.colors === previous.colors) {
            baseline = base;
            active = previous;
          } else {
            baseline = previousBase;
            active = previousActive;
          }
          if (oldState && oldBinding?.live) {
            configureCanvas(oldBinding, oldState);
            drawCanvas(oldBinding, true);
          } else if (oldState) {
            const restored = acquireCanvas(ctx);
            configureCanvas(restored, oldState);
            drawCanvas(restored, true);
          } else {
            clearCanvas(false);
            // A restored snapshot also needs a native redraw to remove painted blanks.
            binding?.tui.renderNow(true);
          }
        } catch {
          // Never leave a failed adapter rewriting later output or report full success.
          try { clearCanvas(); } catch { /* Preserve the explicit recovery failure below. */ }
          throw new Error("Pi Tone could not complete or fully restore the visual selection. The new choice was not saved. Run /reload before continuing.");
        }
        // Only a successful visual rollback can trigger automatic native recovery.
        // Conflicting owners or failed rollback instead retain explicit manual guidance.
        reloadSafe = nativeRecoveryRequired;
        throw error;
      }
      if (!empty) nativeRecoveryRequired = false; // A successful Tone intentionally owns theme management.
      if (!restoring) {
        ctx.ui.notify(empty
          ? "Original Pi colors restored. Run /reload to restore native theme synchronization."
          : source === "user"
            ? `Applied Tone ${label(name)} from the user themes directory.`
            : `Applied built-in Tone ${label(name)}.`, "info");
      }
      return { applied: true };
    } catch (error) {
      const detail = errorDetail(error, "Unexpected theme error.");
      return { applied: false, detail, nativeRecovery: nativeRecoveryRequired, reloadSafe };
    }
  }

  for (const name of builtInPalettes.keys()) byName.set(name, { name });
  const blockedNames = new Set<string>();
  try {
    const directory = userThemeDirectory(); // No user directory is a normal first-install state.
    for (const entry of directory === undefined ? [] : readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const name = entry.name.slice(0, -5);
      const problem = filenameError(entry.name);
      const { command } = commandParts(name);
      const reason = problem ?? (command === "tone-off"
        ? "/tone-off is reserved for disabling Pi Tone."
        : entry.isSymbolicLink() ? "theme files must not be symbolic links."
        : !entry.isFile() ? "expected a regular JSON file." : undefined);
      if (reason !== undefined) {
        warnings.push({ name, message: `Skipped user theme ${label(entry.name)}: ${reason}` });
        blockedNames.add(name); // A bad user entry must not expose a same-name built-in palette.
        continue;
      }
      byName.set(name, { name }); // Exact names deduplicate; sources are never merged.
    }
  } catch (error) {
    const message = `Could not scan the user themes directory: ${errorDetail(error, "Unexpected directory error.")}`;
    warnings.push({ kind: "user-directory", message: `${message} Check access and run /reload.` });
    // Unknown user contents must not silently expose a possibly shadowed built-in palette.
    userDiscoveryError = message;
  }
  for (const name of blockedNames) byName.delete(name);
  for (const name of [...byName.keys()].sort()) {
    const candidate = byName.get(name);
    if (!candidate) continue;
    const { command, args } = commandParts(name);
    const candidates = groups.get(command) ?? new Map<string, Candidate>();
    candidates.set(args, candidate);
    groups.set(command, candidates);
  }

  pi.registerCommand("tone-off", {
    description: "Disable Pi Tone, clear its saved default, and restore Pi's native theme handling.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (args !== "") {
        ctx.ui.notify("Usage: /tone-off", "warning");
        return;
      }
      if (typeof ctx.ui.setTheme !== "function" || typeof ctx.reload !== "function") {
        ctx.ui.notify("Pi Tone requires an interactive terminal with theme and reload support.", "warning");
        return;
      }
      // Native reload refuses an active response or compaction. Never abort user work to turn Tone off.
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for Pi to finish its current work and queued messages, then run /tone-off again.", "warning");
        return;
      }
      // An explicit choice supersedes automatic restoration, but must not snapshot the
      // holding theme while Pi is still rebuilding its native baseline.
      const discardHolding = holdingTheme !== undefined && ctx.ui.theme.colors === holdingTheme.colors;
      const generation = ++selectionGeneration;
      const pending = nativeReady;
      // Off must also recover if a failed native reload never replaced the witness.
      if (pending && !discardHolding && !(await pending)) return;
      if (generation !== selectionGeneration) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for Pi to finish its current work and queued messages, then run /tone-off again.", "warning");
        return;
      }
      cancelRestore();
      let restored = false;
      try {
        if (!discardHolding && baseline && active && ctx.ui.theme.colors === active.colors) {
          replaceTheme(merge(baseline, { colors: {} }), active, baseline, ctx);
          restored = true;
          nativeRecoveryRequired = true;
        }
      } catch (error) {
        const detail = errorDetail(error, "Unexpected theme error.");
        ctx.ui.notify(`Could not turn Pi Tone off: ${detail} The saved selection was not cleared.`, "error");
        return;
      }
      try { clearCanvas(); } catch {
        ctx.ui.notify("Pi Tone could not finish canvas cleanup. The saved choice was not cleared. Retry /reload, then /tone-off.", "error");
        return;
      }
      try {
        clearPreference();
      } catch (error) {
        const detail = errorDetail(error, "Unexpected preference error.");
        ctx.ui.notify(`Pi Tone: ${restored ? "Original Pi colors restored" : "Current Pi colors unchanged"}, but the saved default could not be cleared: ${detail} Tone may return after reload or restart.`, "warning");
        return;
      }
      if (!restored && !discardHolding && !nativeRecoveryRequired) {
        ctx.ui.notify("Pi Tone is off. The saved selection is cleared; the current Pi theme is unchanged.", "info");
        return;
      }
      ctx.ui.notify(discardHolding || !restored
        ? "Saved Tone cleared. Reloading Pi to restore its native theme."
        : "Original Pi colors restored and saved Tone cleared. Reloading Pi to restore native theme handling.", "info");
      // Reload is terminal for this handler: Pi owns diagnostics and the replacement runtime.
      // It also restores native watchers/appearance sync without writing settings or private APIs.
      await ctx.reload();
    },
  });

  for (const [command, candidates] of groups) {
    const only = candidates.size === 1 ? [...candidates.values()][0] : undefined;
    // Discovery metadata only: never cache palette contents, paths or source safety.
    const completions = [...candidates.entries()]
      .filter(([args]) => args !== "")
      .map(([args, { name }]) => ({ value: args, label: `/tone-${name}` }));
    pi.registerCommand(command, {
      description: only
        ? `Apply ${only.name} color overrides and remember the selection for future Pi startups.`
        : "Apply and remember the Pi Tone JSON whose full filename follows this command.",
      getArgumentCompletions: (prefix) => {
        const items: { value: string; label: string }[] = [];
        for (const item of completions) {
          if (item.value.startsWith(prefix)) items.push({ ...item });
        }
        return items.length === 0 ? null : items;
      },
      handler: async (args, ctx) => {
        if (ctx.mode !== "tui") return;
        const candidate = candidates.get(args);
        if (candidate === undefined) {
          ctx.ui.notify(`No matching Pi Tone file. Use ${usages(candidates)}.`, "warning");
          return;
        }
        if (holdingTheme && ctx.ui.theme.colors === holdingTheme.colors) {
          ctx.ui.notify("Pi's native theme reset is still pending. Finish or retry /reload, then select the Tone again.", "warning");
          return;
        }
        const generation = ++selectionGeneration;
        const pending = nativeReady;
        if (pending && !(await pending)) return;
        if (generation !== selectionGeneration) return;
        cancelRestore();
        const result = apply(candidate, ctx, false);
        if (!result.applied) {
          let reloading = false;
          // Do not replay an older saved Tone or loop on a failed saved canvas. Only a
          // command context can reload, and only a known-absent preference is safe here.
          if (result.nativeRecovery && result.reloadSafe && typeof ctx.reload === "function"
              && ctx.isIdle() && !ctx.hasPendingMessages()) {
            try { reloading = readPreference() === undefined; } catch { /* Preserve unreadable state; recovery stays explicit. */ }
          }
          reportApplyFailure(candidate, ctx, false, result, reloading);
          if (reloading) {
            cancelRestore();
            // Terminal operation: never access this runtime/context after native reload.
            await ctx.reload();
          }
          return;
        }
        try {
          savePreference(candidate.name);
        } catch (error) {
          const detail = errorDetail(error, "Unexpected preference error.");
          ctx.ui.notify(`Pi Tone applied for this session, but the default could not be saved: ${detail}`, "warning");
        }
      },
    });
  }

  // Work on a per-event copy: later reloads must still report unresolved problems.
  // Match full logical names, never truncated labels or substrings of error messages.
  function savedCandidate(diagnostics: Diagnostic[]): Candidate | undefined {
    let name: string | undefined;
    try {
      name = readPreference();
      if (name === undefined) return undefined;
      requireToneName(name);
      if (userDiscoveryError !== undefined) {
        // The same user-directory failure would also block readTone(candidate). Replace
        // its general discovery diagnostic with one saved-Tone diagnostic for this event.
        for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
          if (diagnostics[index]?.kind === "user-directory") diagnostics.splice(index, 1);
        }
        diagnostics.unshift({
          message: `Could not restore saved Tone ${label(name)}: ${userDiscoveryError} Fix the user directory and run /reload.`,
        });
        return undefined;
      }
      const candidate = byName.get(name);
      if (!candidate) throw new Error("The saved Tone is neither built in nor among the discovered user themes. Check the file and run /reload.");
      return candidate;
    } catch (error) {
      const related = name === undefined ? [] : diagnostics.filter((item) => item.name === name);
      const detail = (name === undefined ? undefined : filenameError(`${name}.json`))
        ?? (related.length ? related.map((item) => item.message).join(" ")
          : errorDetail(error, "Unexpected preference error."));
      if (name !== undefined) {
        for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
          if (diagnostics[index]?.name === name) diagnostics.splice(index, 1);
        }
      }
      // Prioritize the saved-selection failure so the display limit cannot hide it.
      diagnostics.unshift({ message: name === undefined
        ? `Could not restore the saved default: ${detail}`
        : `Could not restore saved Tone ${label(name)}: ${detail}` });
      return undefined;
    }
  }

  function deferRestore(candidate: Candidate, ctx: ExtensionContext): void {
    cancelRestore();
    const generation = selectionGeneration;
    const widgetKey = "pi-tone:restore-saved";
    let live = true;
    let queued = false;
    let resolveReady: (ready: boolean) => void = () => {};

    // A colors object can change on a terminal reply without a theme replacement.
    // Retain a concrete, visually identical Theme as an identity witness instead.
    // Comparing against witness.colors on each render survives those cache changes.
    let prepared: PreparedTone;
    let witness: Theme;
    try {
      prepared = readTone(candidate);
      const { patch } = prepared;
      if (Object.keys(patch.colors).length === 0 && patch.canvas === undefined) return; // Pi's upcoming reset is sufficient.
      if (patch.canvas) {
        let checked = false;
        try {
          ctx.ui.setWidget(widgetKey, (tui) => {
            requireCanvasHost(tui);
            checked = true;
            return { render: () => [], invalidate: () => {} };
          });
          if (!checked) throw new Error("Pi did not provide a synchronous canvas capability check.");
        } finally { ctx.ui.setWidget(widgetKey, undefined); }
      }
      const before = snapshot(ctx);
      merge(before, patch); // Validate every role before changing any host state.
      witness = merge(before, { colors: {} });
      replaceTheme(witness, merge(before, { colors: {} }), before, ctx);
      holdingTheme = witness;
    } catch (error) {
      const detail = errorDetail(error, "Unexpected theme error.");
      ctx.ui.notify(`Pi Tone: Could not prepare the saved Tone: ${detail} Tone: ${label(candidate.name)}.${nativeRecoveryRequired
        ? " Native theme management has not been confirmed restored. Finish or retry /reload; /tone-off clears the saved choice and requests native recovery." : ""}`, "warning");
      return;
    }

    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    nativeReady = ready;
    function settle(success: boolean, removeWidget: boolean): void {
      if (!live) return;
      live = false;
      nativeReady = undefined;
      cancelDeferredRestore = undefined;
      if (success) {
        // The holding theme is never an inheritance baseline for the restored Tone.
        baseline = undefined;
        active = undefined;
        holdingTheme = undefined;
        nativeRecoveryRequired = false;
      }
      if (removeWidget) ctx.ui.setWidget(widgetKey, undefined);
      resolveReady(success);
    }
    cancelDeferredRestore = () => settle(false, true);
    void ready.then((success) => {
      if (success && generation === selectionGeneration) {
        const result = apply(candidate, ctx, true, prepared);
        if (!result.applied) reportApplyFailure(candidate, ctx, true, result);
      }
    });

    try {
      ctx.ui.setWidget(widgetKey, (tui) => ({
        render: () => {
          if (live && !queued && ctx.ui.theme.colors !== witness.colors) {
            queued = true;
            queueMicrotask(async () => {
              if (!live) return;
              try {
                // The verified Pi host queues its color query in the same synchronous native reset.
                // Queue a public TUI query behind it, then await reply/host timeout.
                // This is a protocol completion barrier, not a fixed-delay sleep.
                await tui.queryTerminalColors({ timeoutMs: 100 });
                if (!live) return;
                if (ctx.ui.theme.colors === witness.colors) {
                  throw new Error("Pi has not replaced the holding theme with a native baseline.");
                }
                settle(true, true);
              } catch (error) {
                if (!live) return;
                settle(false, true);
                const detail = errorDetail(error, "Unexpected terminal query error.");
                ctx.ui.notify(`Pi Tone: Could not finish native theme restoration: ${detail} Retry /reload.`, "warning");
              }
            });
          }
          return [];
        },
        invalidate: () => {},
        dispose: () => settle(false, false),
      }));
    } catch (error) {
      settle(false, false);
      const detail = errorDetail(error, "Unexpected widget error.");
      ctx.ui.notify(`Pi Tone: Could not observe the native theme reset: ${detail} Retry /reload.`, "warning");
    }
  }

  pi.on("session_start", (event, ctx) => {
    // RPC also supports notify(), so hasUI alone is not a TUI-only guard.
    // Stay silent and do not read preferences or change theme state outside TUI.
    if (ctx.mode !== "tui") return;
    cancelRestore();
    clearCanvas();

    // Fresh startup follows Pi's initial color-query completion. Reload/session replacement
    // apply native settings after session_start, so use an identity witness and a bounded
    // public terminal-query barrier before capturing the new baseline. No host patching.
    baseline = undefined;
    active = undefined;
    holdingTheme = undefined;
    nativeRecoveryRequired = false;
    const diagnostics = [...warnings];
    const candidate = savedCandidate(diagnostics);
    if (diagnostics.length) {
      const summary = diagnostics.slice(0, 10).map((item) => item.message).join("\n");
      const remaining = diagnostics.length > 10 ? `\n${diagnostics.length - 10} more diagnostics were omitted.` : "";
      ctx.ui.notify(`Pi Tone: ${summary}${remaining}`, "warning");
    }
    if (candidate === undefined) return;
    if (event.reason === "startup") {
      const result = apply(candidate, ctx, true);
      if (!result.applied) reportApplyFailure(candidate, ctx, true, result);
    } else deferRestore(candidate, ctx);
  });

  pi.on("session_shutdown", () => {
    cancelRestore();
    clearCanvas();
  });
}
