import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSystemErrorMap } from "node:util";
import {
  getAgentDir, Theme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
  type ThemeAppearance, type ThemeBg, type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  colorToHex, parseColor, rgbColor, backgroundAnsi as encodeBackground, foregroundAnsi as encodeForeground,
  type ProgramStatus, type Terminal, type TUI,
} from "@earendil-works/pi-tui";

type Value = string | number;
type ColorMap = Record<string, Value>;
type Foregrounds = ConstructorParameters<typeof Theme>[0];
type Backgrounds = ConstructorParameters<typeof Theme>[1];
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
// One problem found when Pi Tone loads, as a complete message. A skipped palette file keeps its
// palette name, and a palette folder problem is marked, so a saved selection can take them over.
interface Diagnostic {
  message: string;
  name?: string;
  folder?: boolean;
}
type ThemeSource = "user" | "built-in";
interface PreparedTone {
  patch: Patch;
  source: ThemeSource;
  path?: string;
}
// changed: Pi's colors were replaced. empty: the palette sets nothing (setsNothing).
type ApplyResult =
  | { applied: true; source: ThemeSource; empty: boolean; changed: boolean }
  | { applied: false; problem: Problem; nativeRecovery: boolean; reloadSafe: boolean };

const maximumBytes = 256 * 1024;
const foregroundAnsi = /^\x1b\[(?:39|38;5;(\d+)|38;2;(\d+);(\d+);(\d+))m(\x1b\[2m)?$/;
const backgroundAnsi = /^\x1b\[(?:49|48;5;(\d+)|48;2;(\d+);(\d+);(\d+))m$/;
// Characters a terminal acts on instead of showing: C0 and C1 controls, line and paragraph separators,
// and Unicode bidirectional controls. File names may not contain them; messages show them as \uXXXX.
const unsafeCharacters = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const unsafeCharactersEverywhere = new RegExp(unsafeCharacters.source, "gu");

// Messages are plain English sentences that Pi shows in full through its own notifications.
// Text taken from files, paths and errors appears as written, except unsafe characters.
function shown(value: string): string {
  return value.replace(unsafeCharactersEverywhere, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// Plain sentences for the file system errors people meet, about the file or folder the message names.
const fileErrors: Readonly<Record<string, string>> = {
  EACCES: "Pi Tone does not have permission to use it.",
  EPERM: "Pi Tone does not have permission to use it.",
  EROFS: "It is on a read-only file system.",
  ENOSPC: "The disk is full.",
  EDQUOT: "The disk quota is full.",
  ENOTDIR: "Part of its path is not a folder.",
  EISDIR: "It is a folder.",
  ELOOP: "It is a link.",
  ENOENT: "It does not exist.",
  ESTALE: "The network file system lost track of it.",
  ENOTSUP: "Its file system does not support a step Pi Tone needs.",
};

// Other errors from the system are told by the system's own description, or its name for the error,
// without Node's error code, call, and quoted path. Any other error keeps its own message.
function causeOf(error: unknown, fallback = "Something unexpected went wrong."): string {
  if (!(error instanceof Error)) return sentence(fallback);
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const known = code === undefined ? undefined : fileErrors[code];
  if (known !== undefined) return known;
  if (!("syscall" in error) || !("errno" in error) || typeof error.errno !== "number") {
    return sentence(error.message !== "" ? shown(error.message) : fallback);
  }
  // Node names only the errors libuv knows; others, such as a full disk quota or a stale network file
  // handle, come as UNKNOWN with the system's number, which is looked up instead.
  const errno = error.errno;
  const name = Object.entries(osConstants.errno).find(([, value]) => -value === errno)?.[0];
  const plain = name === undefined ? undefined : fileErrors[name];
  if (plain !== undefined) return plain;
  return `The system reported this error: ${shown(getSystemErrorMap().get(errno)?.[1] ?? name ?? "unknown error")}.`;
}

// Characters that take no space on screen, such as U+200B ZERO WIDTH SPACE or U+FEFF: Unicode's default
// ignorable code points. Names and values from a palette file are shown as written, without quotes, so
// whitespace around them, and these characters when they cause a problem, are said in words instead. They
// can also belong to a name, as in emoji or in Persian words, so a message does not blame them otherwise.
const invisibleCharacters = /\p{Default_Ignorable_Code_Point}/gu;
const edgeWhitespace = /^\p{White_Space}+|\p{White_Space}+$/gu;

// Text without whitespace at either end. Unlike String.trim, it keeps U+FEFF, which is not whitespace.
function trimmed(text: string): string {
  return text.replace(edgeWhitespace, "");
}

// The text a reader sees: without invisible characters and without whitespace at either end.
function visible(text: string): string {
  return trimmed(text.replace(invisibleCharacters, ""));
}

// Why a name would look right in a message although it is not, or undefined. `known` tells whether the
// visible text alone is a name of this kind, so an invisible character is named only when it is the cause.
function oddName(kind: string, name: string, known: (text: string) => boolean): string | undefined {
  if (name === "") return `A ${kind} has an empty name.`;
  const seen = visible(name);
  if (seen === "") return `A ${kind} name has no visible characters.`;
  if (seen !== trimmed(name) && known(seen)) return `Unknown ${kind} ${shown(seen)}, written with an invisible character.`;
  if (trimmed(name) !== name) return `Unknown ${kind} ${shown(trimmed(name))}, written with whitespace around it.`;
  return undefined;
}

function unknownName(kind: string, name: string, known: (text: string) => boolean, suffix = ""): string {
  return oddName(kind, name, known) ?? `Unknown ${kind} ${shown(name)}${suffix}.`;
}

// How a message names a variable from vars: as written, since its characters are the user's own.
function variableSubject(name: string): string {
  if (name === "") return "The variable with an empty name";
  if (visible(name) === "") return "A variable whose name has no visible characters";
  if (trimmed(name) !== name) return `The variable ${shown(trimmed(name))}, written with whitespace around it,`;
  return `The variable ${shown(name)}`;
}

// Why a color value that does not work would look right in a message, or undefined. `works` tells whether
// the visible text alone would work, so an invisible character is named only when it is the cause.
function oddValue(value: Value, works: (text: string) => boolean): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const seen = visible(value);
  if (seen === "") return "A color value has no visible characters.";
  if (seen !== trimmed(value) && works(seen)) return `The color value ${shown(seen)} contains an invisible character.`;
  if (trimmed(value) !== value) return `The color value ${shown(trimmed(value))} has whitespace around it.`;
  return undefined;
}

// pi-tui names an OKLCH or OKHSL part that is out of range by one letter and in its own units. Say what
// each part allows instead; a value pi-tui cannot read at all keeps its own message.
function outOfRange(value: Value, error: unknown): string | undefined {
  if (typeof value !== "string" || !(error instanceof Error) || error.message.startsWith("Invalid color value")) return undefined;
  if (/^oklch\(/i.test(value)) {
    return `The color value ${shown(value)} is out of range: in OKLCH, lightness goes from 0% to 100% (or 0 to 1), chroma cannot be negative, and every number must be finite.`;
  }
  if (/^okhsl\(/i.test(value)) {
    return `The color value ${shown(value)} is out of range: in OKHSL, saturation and lightness go from 0% to 100% (or 0 to 1), and every number must be finite.`;
  }
  return undefined;
}

function parses(text: string): boolean {
  try { parseColor(text); return true; } catch { return false; }
}

// A failure told as plain sentences: what went wrong, and what fixes it. A problem in a palette also
// says where the palette comes from and, for a user palette, which file it is.
class Problem extends Error {
  constructor(message: string, readonly fix: string, readonly source?: ThemeSource, readonly path?: string) {
    super(message);
  }
}

const runReload = "Run /reload.";

// Any error as a problem. Unexpected errors keep their own message and suggest trying again.
function problemOf(error: unknown, command: string): Problem {
  return error instanceof Problem ? error : new Problem(causeOf(error), `Run ${command} to try again.`);
}

function describe(name: string, source: ThemeSource | undefined): string {
  return source === "user" ? `your palette ${shown(name)}`
    : source === "built-in" ? `the built-in palette ${shown(name)}`
    : `the palette ${shown(name)}`;
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
const canvasSizeLimit = `The terminal size is outside what a canvas supports (1 to ${maximumCanvasAxis} columns and rows, and at most ${maximumCanvasCells} cells).`;
function requireCanvasHost(tui: TUI, command: string): void {
  if (tui.mode !== "fullscreen" || typeof tui.renderNow !== "function" || typeof tui.requestRender !== "function") {
    throw new Problem("This palette has a canvas, which works only in Pi's fullscreen mode.",
      `Switch Pi to fullscreen mode in /settings, then run ${command}. Or choose a palette without a canvas.`);
  }
  const terminal = tui.terminal;
  if (!terminal || typeof terminal.write !== "function" || !validCanvasDimensions(terminal.columns, terminal.rows)) {
    throw new Problem(canvasSizeLimit, `Resize the terminal, then run ${command}.`);
  }
}

// One piece of a fullscreen frame: printable text, a control sequence (CSI), another escape
// sequence, or the opaque body of a string sequence (OSC, DCS, APC, PM, SOS) such as a link or an image.
interface FramePart {
  value: string;
  kind: "text" | "csi" | "escape" | "string";
}

// The canvas understands only these parts of Pi's fullscreen frames: text without line feeds,
// colors and styles, cursor placement and movement, cursor visibility and shape, harmless input
// modes, and opaque strings. The full-screen clear and the row erase are checked in paintFrame.
// Anything else (erasing or inserting characters, scrolling, line feeds, unknown sequences) could
// leave cells unpainted, so the canvas stops instead of guessing.
const harmlessPrivateModes = new Set(["1", "12", "25", "1000", "1002", "1003", "1004", "1005", "1006", "1015", "1016", "2004", "2026"]);
function supportedPart(part: FramePart): boolean {
  if (part.kind === "string") return true;
  if (part.kind === "text") return !/[\u0000-\u0006\u000A-\u000C\u000E-\u001F\u007F-\u009F]/u.test(part.value);
  // Save and restore the cursor, keypad modes, and the introducers of opaque strings.
  if (part.kind === "escape") return /^\x1b[78=>\]P_^X]$/.test(part.value);
  const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])$/.exec(part.value);
  const [, parameters = "", intermediates = "", final = ""] = match ?? [];
  return match !== null && (
    (intermediates === "" && final === "m" && /^[0-9:;]*$/.test(parameters))
    || (intermediates === "" && /^[ABCDEFGHadef`]$/.test(final) && /^[0-9;]*$/.test(parameters))
    || (intermediates === "" && /^[su]$/.test(final) && parameters === "")
    || (intermediates === "" && final === "u" && /^[<>=?][0-9;]*$/.test(parameters))
    || (intermediates === " " && final === "q" && /^[0-9]*$/.test(parameters))
    || (intermediates === "" && /^[hl]$/.test(final) && /^\?[0-9;]+$/.test(parameters)
      && parameters.slice(1).split(";").every((mode) => harmlessPrivateModes.has(mode)))
    || (intermediates === "" && (final === "J" || final === "K")));
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
  private completed = 0;
  private covered = false;

  // Limit buffered frames, including opaque graphics data. No unbounded CSI/image buffer.
  private static readonly maximumFrame = 16 * 1024 * 1024;
  private static readonly maximumParts = 262144;

  constructor(
    readonly original: Terminal,
    // Whether this frame may be painted: the canvas is current, in fullscreen, and its theme is shown.
    private readonly enabled: () => boolean,
    // Called when painting failed or a running canvas was not allowed to paint; the extension decides.
    private readonly notice: () => void,
  ) {}

  get columns(): number { return this.original.columns; }
  get rows(): number { return this.original.rows; }
  get kittyProtocolActive(): boolean { return this.original.kittyProtocolActive; }
  get atBoundary(): boolean { return this.state === "text" && !this.inFrame; }
  get error(): Error | undefined { return this.failure; }
  get paintedFrames(): number { return this.completed; }
  get fullGridPainted(): boolean { return this.covered; }

  configure(paint: CanvasAnsi | undefined): void {
    if (!this.atBoundary || this.released) throw new Error("The canvas cannot change while Pi is drawing the screen.");
    this.paint = paint;
    this.failure = undefined;
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
  // Checked at runtime so hosts without this method remain tolerated.
  setProgramStatus(status: ProgramStatus): void {
    if (typeof this.original.setProgramStatus === "function") this.original.setProgramStatus(status);
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

  // Write out whatever of Pi's output is still buffered, unchanged. Nothing of our own is added:
  // every painted frame already ends with the default colors, and outside frames nothing is changed.
  private flush(): void {
    const raw = (this.frame?.map((part) => part.value).join("") ?? "") + this.pending;
    this.frame = undefined;
    this.pending = "";
    this.frameLength = 0;
    this.state = "text";
    this.inFrame = false;
    if (raw) this.original.write(raw);
  }

  private fault(message: string): void {
    if (this.failure) return;
    this.failure = new Error(message);
    this.notice();
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
    if (this.autoWrap) throw new Error("Pi turned on line wrapping inside the screen, which the canvas cannot paint around.");
    const width = this.columns;
    const height = this.rows;
    if (!validCanvasDimensions(width, height)) throw new Error(canvasSizeLimit);
    const rows = new Set<number>();
    const erase = new Set<number>();
    let firstRow = -1;
    let screenClear = false;
    // Recognize only Pi's own fullscreen layout: every redrawn row starts with CUP(row,1) and EL(2),
    // and a full redraw starts with ED(2). No text width is estimated and no cursor is emulated.
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part) continue;
      if (!supportedPart(part)) throw new Error("Pi wrote terminal output that the canvas does not recognize.");
      if (part.kind !== "csi") continue;
      const final = part.value.slice(-1);
      if (final === "J") {
        if (part.value !== "\x1b[2J" || firstRow !== -1) {
          throw new Error("Pi cleared the screen in a way the canvas does not recognize.");
        }
        screenClear = true;
      } else if (final === "K") {
        const previous = parts[i - 1];
        const position = previous?.kind === "csi" ? /^\x1b\[([1-9][0-9]*);1H$/.exec(previous.value) : null;
        const row = Number(position?.[1]);
        if (part.value !== "\x1b[2K" || !position || row > height || rows.has(row)) {
          throw new Error("Pi erased a line in a way the canvas does not recognize.");
        }
        if (firstRow === -1) firstRow = i - 1;
        rows.add(row);
        erase.add(i);
      }
    }
    if (screenClear && firstRow === -1) throw new Error("Pi cleared the screen without redrawing its rows.");
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
      if (part.kind === "csi" && part.value.endsWith("m")) {
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

  private accept(value: string, kind: FramePart["kind"], output: string[]): void {
    const csi = kind === "csi";
    if (csi && value === "\x1b[?7h") {
      this.autoWrap = true;
      // Pi's normal pre-stop frame enables autowrap before returning to the shell.
      // Forward transition frames unchanged, rather than treating orderly suspension as a fault.
      if (this.frame) {
        for (const part of this.frame) output.push(part.value);
        this.frame = undefined;
        this.frameLength = 0;
      }
      output.push(value);
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
      output.push(value);
      return;
    }
    if (csi && value === "\x1b[?2026h") {
      if (this.inFrame) {
        this.fault("Pi started a new screen update before finishing the previous one.");
        if (this.frame) for (const part of this.frame) output.push(part.value);
        this.frame = undefined;
      }
      this.inFrame = true;
      const enabled = !this.failure && !this.stopped && this.alternate && this.paint !== undefined && this.enabled();
      // A running canvas that may not paint this frame (another renderer, terminal owner or theme)
      // is checked by the extension, which decides whether to report it or let it go quietly.
      if (!enabled && this.paint !== undefined && !this.failure && !this.stopped) this.notice();
      if (enabled) { this.frame = []; this.frameLength = 0; }
    }
    if (this.frame) {
      this.frame.push({ value, kind });
      this.frameLength += value.length;
      if (this.frameLength > CanvasTerminal.maximumFrame || this.frame.length > CanvasTerminal.maximumParts) {
        this.fault("A screen update was too large for the canvas to check safely.");
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
          this.fault(error instanceof Error ? error.message : "The canvas could not paint a screen update.");
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
        if (next === -1) { this.accept(data.slice(index), "text", output); break; }
        if (next > index) this.accept(data.slice(index, next), "text", output);
        this.pending = "\x1b";
        this.state = "escape";
        index = next + 1;
      } else if (this.state === "escape") {
        const char = data.charAt(index++);
        this.pending += char;
        if (char === "[") this.state = "csi";
        else {
          this.accept(this.pending, "escape", output);
          this.pending = "";
          this.osc = char === "]";
          this.state = "]P_^X".includes(char) ? "string" : "text";
        }
      } else if (this.state === "csi") {
        const char = data.charAt(index++);
        this.pending += char;
        if (char >= "@" && char <= "~") {
          this.accept(this.pending, "csi", output);
          this.pending = "";
          this.state = "text";
        } else if (this.pending.length > 128 || char < " " || char > "?") {
          this.accept(this.pending, "escape", output);
          this.pending = "";
          this.state = "text";
          if (this.frame) this.fault("Pi wrote a malformed control sequence.");
        }
      } else if (this.state === "string-escape") {
        const char = data.charAt(index++);
        this.accept(char, "string", output);
        this.state = char === "\\" ? "text" : char === "\x1b" ? "string-escape" : "string";
      } else {
        // OSC/DCS/APC are opaque: embedded SGR or frame markers are never interpreted.
        const escape = data.indexOf("\x1b", index);
        const bell = this.osc ? data.indexOf("\x07", index) : -1;
        const end = escape < 0 ? bell : bell < 0 ? escape : Math.min(escape, bell);
        if (end < 0) { this.accept(data.slice(index), "string", output); break; }
        this.accept(data.slice(index, end + 1), "string", output);
        this.state = end === bell ? "text" : "string-escape";
        index = end + 1;
      }
    }
    if (output.length) this.original.write(output.join(""));
  }
}

const isCanvasKey = (text: string): boolean => text === "background" || text === "foreground";

function parseCanvas(document: Record<string, unknown>, resolve: (value: unknown) => Value): CanvasSpec | undefined {
  if (!Object.hasOwn(document, "canvas")) return undefined;
  const canvas = object(document["canvas"], "canvas");
  // Unknown keys first, so a background written with spaces around it is named as such.
  for (const key of Object.keys(canvas)) {
    if (key !== "background" && key !== "foreground") throw new Error(unknownName("canvas property", key, isCanvasKey));
  }
  if (!Object.hasOwn(canvas, "background")) throw new Error("canvas.background is required when canvas is present.");
  const background = checked("The canvas background", () => resolve(canvas["background"]));
  const foreground = Object.hasOwn(canvas, "foreground")
    ? checked("The canvas foreground", () => resolve(canvas["foreground"])) : undefined;
  // A canvas requests explicit painting; omit canvas to leave terminal defaults alone.
  if (background === "" || foreground === "") throw new Error("Canvas colors must be explicit colors, not terminal defaults.");
  return { background, ...(foreground === undefined ? {} : { foreground }) };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

// Why a file that has to be a regular file is not one, as a sentence, or undefined.
function notRegularFile(stat: { isSymbolicLink(): boolean; isFile(): boolean; nlink: number }): string | undefined {
  if (stat.isSymbolicLink()) return "It is a link.";
  if (!stat.isFile()) return "It is not a regular file.";
  if (stat.nlink !== 1) return "It has other hard links.";
  return undefined;
}

function tooLarge(limit: number): string {
  return `It is larger than the ${limit % 1024 === 0 ? `${limit / 1024} KiB` : `${limit} bytes`} limit.`;
}

// Configuration is data only. Bound reads and reject nonregular files and symlinks.
function readBytes(fd: number, limit: number): Buffer {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new Error("It is not a regular file.");
  if (stat.size > limit) throw new Error(tooLarge(limit));
  const buffer = Buffer.alloc(stat.size + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = readSync(fd, buffer, size, buffer.length - size, size);
    if (count === 0) break;
    size += count;
  }
  if (size !== stat.size) throw new Error("It changed while it was being read.");
  return buffer.subarray(0, size);
}

function readFile(path: string, limit: number): Buffer {
  if (realpathSync(path) !== path) throw new Error("It is a link, or it is inside a linked folder.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    return readBytes(fd, limit);
  } finally {
    closeSync(fd);
  }
}

// UTF-8 text (a byte order mark is allowed) holding one JSON object. JSON's own error message is not
// shown: it quotes a shortened piece of the file. Its line and column are kept when it has them.
function parseDocument(bytes: Buffer): Record<string, unknown> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new Error("It is not valid UTF-8 text.");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    const at = /\(line (\d+) column (\d+)\)/.exec(error instanceof Error ? error.message : "");
    throw new Error(`It is not valid JSON${at ? ` at line ${at[1]}, column ${at[2]}` : ""}. Comments and trailing commas are not allowed.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("It must contain a JSON object.");
  return value as Record<string, unknown>;
}

function readDocument(path: string): Record<string, unknown> {
  return parseDocument(readFile(path, maximumBytes));
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// One permanent preference, outside the installed package. Never store colors or a theme copy.
const preferenceLimit = 4096;
function preferencePath(): string {
  return join(realpathSync(getAgentDir()), "pi-tone.json");
}

// The saved selection as the user configured its path, for messages. File operations use preferencePath().
function preferenceFile(): string {
  return join(getAgentDir(), "pi-tone.json");
}

// A palette command overwrites a saved selection it can read as a small regular file; /tone-off deletes it.
const replaceSelection = "Run a palette command to save a new selection, or /tone-off to clear it.";
function readPreference(): string | undefined {
  let path: string;
  let stat: ReturnType<typeof lstatSync>;
  try {
    path = preferencePath();
    stat = lstatSync(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const kind = stat === undefined ? undefined : notRegularFile(stat);
  if (kind !== undefined) throw new Problem(kind, "Delete it, then run /reload.");
  if (stat !== undefined && stat.size > preferenceLimit) {
    throw new Problem(tooLarge(preferenceLimit), "Run /tone-off to clear it, or delete that file.");
  }
  let bytes: Buffer;
  try { bytes = readFile(path, preferenceLimit); } catch (error) {
    throw new Problem(causeOf(error), "Fix or delete that file, then run /reload.");
  }
  let document: Record<string, unknown>;
  try { document = parseDocument(bytes); } catch (error) {
    throw new Problem(causeOf(error), replaceSelection);
  }
  const tone = document["tone"];
  if (Object.keys(document).length !== 1 || typeof tone !== "string") {
    throw new Problem('It must contain only {"tone": "<palette name>"}.', replaceSelection);
  }
  if (tone === "") throw new Problem("Its palette name is empty.", replaceSelection);
  // Validate the logical name when resolving the saved choice, so its discovery
  // diagnostic and restoration failure can be reported together without duplication.
  return tone;
}

function writeBytes(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error("Writing it stopped before the end.");
    offset += count;
  }
  ftruncateSync(fd, bytes.length);
  fsyncSync(fd);
}

// The name in an existing selection file, or undefined when it does not hold exactly one.
function savedName(bytes: Buffer): string | undefined {
  try {
    const document = parseDocument(bytes);
    const tone = document["tone"];
    return Object.keys(document).length === 1 && typeof tone === "string" ? tone : undefined;
  } catch {
    return undefined;
  }
}

function savePreference(name: string): void {
  const bytes = Buffer.from(`${JSON.stringify({ tone: name }, null, 2)}\n`, "utf8");
  if (bytes.length > preferenceLimit) throw new Error("The palette name is too long to save.");
  mkdirSync(getAgentDir(), { recursive: true, mode: 0o700 });
  const path = preferencePath();
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path);
    // Pi Tone never writes through a link or into a file with other names, and does not read a file over
    // the limit; once that file is deleted, a new one is made.
    const kind = notRegularFile(existing) ?? (existing.size > preferenceLimit ? tooLarge(preferenceLimit) : undefined);
    if (kind !== undefined) throw new Problem(kind, `Delete it, then run /tone-${shown(name)} again.`);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const flags = constants.O_RDWR | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags | (existing ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  // A file made by this save is removed again unless the save finishes, so a failed first save leaves no
  // empty selection behind.
  let made = existing === undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 ||
        (existing && (stat.dev !== existing.dev || stat.ino !== existing.ino)) || realpathSync(path) !== path) {
      throw new Error("It changed while it was being saved, or it is not a regular file.");
    }
    const previous = readBytes(fd, preferenceLimit);
    if (previous.equals(bytes) || savedName(previous) === name) {
      made = false;
      return;
    }
    // Direct write: no temporary file. Restore previous bytes on a recoverable write failure.
    try {
      writeBytes(fd, bytes);
      made = false;
    } catch (error) {
      if (!made && !restored(fd, previous)) throw new Error(`${causeOf(error)} Its previous content could not be put back.`);
      throw error;
    }
  } catch (error) {
    if (made) removeMade(path, fd);
    throw error;
  } finally {
    closeSync(fd);
  }
}

// Put the previous bytes back after a failed write. True when the file holds them again, also when the
// failed write had not changed it.
function restored(fd: number, previous: Buffer): boolean {
  try {
    writeBytes(fd, previous);
    return true;
  } catch {
    try { return readBytes(fd, preferenceLimit).equals(previous); } catch { return false; }
  }
}

// Remove the file a failed save made, if `path` still names it. If it stays, the next start reports it
// with a way to clear it.
function removeMade(path: string, fd: number): void {
  try {
    const mine = fstatSync(fd);
    const now = lstatSync(path);
    if (now.dev === mine.dev && now.ino === mine.ino) unlinkSync(path);
  } catch { /* See above. */ }
}

// Remove only our fixed preference path. Missing or malformed JSON needs no replacement file.
function clearPreference(): void {
  try {
    const path = preferencePath();
    const stat = lstatSync(path);
    const kind = notRegularFile(stat) ?? (realpathSync(path) !== path ? "It is a link." : undefined);
    if (kind !== undefined) throw new Error(kind);
    unlinkSync(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function resolver(document: Record<string, unknown>): (value: unknown) => Value {
  const vars = document["vars"] === undefined ? {} : object(document["vars"], "vars");
  const cache = new Map<string, Value>();
  // Whether visible text would work as a color value: a variable of this file or a color.
  const works = (text: string): boolean => Object.hasOwn(vars, text) || parses(text);
  // A missing variable that looks like a defined one, whose name has whitespace or invisible characters.
  function lookalike(text: string): string | undefined {
    const seen = visible(text);
    const match = Object.keys(vars).find((other) => other !== text && visible(other) === seen);
    if (match === undefined) return undefined;
    const how = visible(match) !== trimmed(match) ? "an invisible character" : "whitespace around it";
    return `Missing color variable ${shown(text)}. The variable ${shown(seen)} in vars is written with ${how}.`;
  }
  function resolve(value: unknown): Value {
    const chain = new Set<string>();
    while (typeof value === "string" && value !== "" && !value.startsWith("#") && !/^ok(lch|hsl)\(/i.test(value)) {
      const cached = cache.get(value);
      if (cached !== undefined) { value = cached; break; }
      if (!Object.hasOwn(vars, value)) throw new Error(oddValue(value, works) ?? lookalike(value) ?? `Missing color variable ${shown(value)}.`);
      if (chain.has(value)) throw new Error(`Circular color variable ${shown(value)}.`);
      chain.add(value);
      value = vars[value];
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error("Colors must be strings or ANSI color numbers from 0 to 255.");
    }
    if (value !== "") {
      try { parseColor(value); } catch (error) {
        throw new Error(oddValue(value, works) ?? outOfRange(value, error) ?? causeOf(error));
      }
    }
    for (const name of chain) cache.set(name, value);
    return value;
  }
  for (const name of Object.keys(vars)) checked(variableSubject(name), () => resolve(vars[name]));
  return resolve;
}

// Say which color an error belongs to.
function checked<T>(subject: string, read: () => T): T {
  try { return read(); } catch (error) {
    throw new Error(`${subject} is not valid. ${causeOf(error)}`);
  }
}

function colorMap(document: Record<string, unknown>, key: string, resolve: (value: unknown) => Value): ColorMap {
  const values = document[key] === undefined ? {} : object(document[key], key);
  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    // A role name is never empty and never has whitespace around it or invisible characters in it; say so
    // before the value is checked.
    const odd = oddName("color role", name, looksLikeRole);
    if (odd !== undefined) throw new Error(odd);
    return [name, checked(`The color of ${shown(name)}`, () => resolve(value))];
  }));
}

const documentKeys = ["$schema", "name", "appearance", "vars", "colors", "canvas"];
const isDocumentKey = (text: string): boolean => documentKeys.includes(text);
// Pi's color roles are names made of letters and digits.
const looksLikeRole = (text: string): boolean => /^[A-Za-z][A-Za-z0-9]*$/.test(text);

function parsePatch(document: Record<string, unknown>, name: string): Patch {
  if (Object.hasOwn(document, "export")) {
    throw new Error("export is not supported; Pi Tone only changes colors in Pi.");
  }
  for (const key of Object.keys(document)) {
    if (!isDocumentKey(key)) throw new Error(unknownName("property", key, isDocumentKey));
  }
  const declared = document["name"];
  if (declared !== name) {
    const lookalike = typeof declared === "string" && declared !== "" && visible(declared) === visible(name);
    throw new Error(`Its name field must be exactly the file name without .json.${lookalike ? " The two differ only in whitespace or invisible characters." : ""}`);
  }
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
  if (!match) throw new Problem("This Pi version stores theme colors in a way Pi Tone does not support.", "Update Pi Tone.");
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
    else throw new Error(unknownName("color role", key, (text) => Object.hasOwn(fg, text) || Object.hasOwn(bg, text), " for this Pi version"));
  }
  // All original slots are present, including optional and future runtime tokens.
  return new Theme(fg as Foregrounds, bg as Backgrounds, base.mode, {
    name: base.name, appearance: patch.appearance ?? base.appearance,
    dim: base.dim.filter((key) => !Object.hasOwn(patch.colors, key)),
  });
}

// A palette that sets no colors, no canvas, and no appearance changes nothing, which is not the same as Off.
function setsNothing(patch: Patch): boolean {
  return Object.keys(patch.colors).length === 0 && patch.canvas === undefined && patch.appearance === undefined;
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

// Why a palette file name cannot be used, as a sentence, or undefined. The same rules apply when
// palettes are discovered, when the saved selection is read, and when a palette is applied.
function filenameError(filename: string): string | undefined {
  const name = filename.slice(0, -5);
  if (name === "") return "There is no name before .json.";
  if (name.includes("@")) return "@ is not allowed in palette file names, because Pi uses it for file references.";
  if (name.startsWith(".")) return "A palette file name cannot start with a period.";
  if (name.includes(".")) return "A palette file name can have only one period, the one in .json.";
  if (/[\/\\]/u.test(name)) return "A palette file name cannot contain / or \\.";
  if (visible(name) === "") return "The palette name has no visible characters.";
  // Pi trims the command line as String.trim does, which also removes U+FEFF, an invisible character.
  if (name.trimEnd() !== name) {
    return /\p{White_Space}$/u.test(name)
      ? "The palette name ends with whitespace, which Pi commands cannot keep."
      : "The palette name ends with an invisible character, which Pi commands cannot keep.";
  }
  if (unsafeCharacters.test(name)) {
    return "The name contains a control character, a line or paragraph separator, or a Unicode bidirectional formatting character.";
  }
  // Pi's command list ignores letter case, so /tone-Off could be chosen when /tone-off was meant,
  // and off gray would become /tone-off with the text gray.
  if (commandParts(name).command.toLowerCase() === "tone-off") {
    return "A name that is off, or starts with off and a space, in any letter case, is reserved for /tone-off.";
  }
  return undefined;
}

function requireToneName(name: string): void {
  const problem = filenameError(`${name}.json`);
  if (problem !== undefined) throw new Problem(`The palette name ${shown(name)} is not allowed. ${problem}`, "Rename the file, then run /reload.");
}

// User-owned data stays outside the replaceable package. Discovery never creates directories.
// `what` names the folder in a problem: "It" for the palette folder, which the message names already.
function directoryIfPresent(path: string, what: string): string | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${what} must be a real folder, not a file or a link.`);
  }
  return path;
}

// Pi Tone's own folder overlaps the palette folder; only installing it elsewhere fixes this.
class PlacementError extends Error {}

// The device and file number of an existing folder or file, read exactly, or undefined when nothing is
// there. A path that runs through a file leads nowhere either.
function identity(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (missing(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) return undefined;
    throw error;
  }
}

// Whether two real paths name the same folder. Paths that differ only in letter case or Unicode
// normalization are the same folder when the file system says so, as on file systems that ignore letter
// case. File numbers alone are not trusted: some file systems, such as ReFS, do not keep them unique.
function sameFolder(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.normalize("NFC").toLowerCase() !== b.normalize("NFC").toLowerCase()) return false;
  const first = identity(a);
  return first !== undefined && first === identity(b);
}

// Whether `outer` is `inner` or one of its parent folders.
function encloses(outer: string, inner: string): boolean {
  for (let path = inner; ; path = dirname(path)) {
    if (sameFolder(outer, path)) return true;
    if (dirname(path) === path) return false;
  }
}

// The folder Pi loaded this copy of Pi Tone from, found when Pi Tone loads. Moving or removing the folder
// later does not change which copy is running, so it is not looked up again.
let loadedFrom: string | undefined;
function packageFolder(): string {
  loadedFrom ??= realpathSync(fileURLToPath(new URL("./", import.meta.url)));
  return loadedFrom;
}

function userThemeDirectory(): string | undefined {
  const packageRoot = packageFolder();
  let agent: string;
  try { agent = realpathSync(getAgentDir()); } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const userRoot = join(agent, "pi-tone");
  const directory = join(userRoot, "themes");
  // Package updates may clean the package tree, so it must never contain or sit inside user data.
  const contains = encloses(packageRoot, directory);
  const inside = encloses(directory, packageRoot);
  if (contains || inside) {
    const relation = contains && inside ? "is" : contains ? "contains" : "is inside";
    throw new PlacementError(`Pi Tone is installed in ${shown(packageRoot)}, which ${relation} your palette folder ${shown(directory)}.`);
  }
  if (directoryIfPresent(userRoot, shown(userRoot)) === undefined) return undefined;
  return directoryIfPresent(directory, "It");
}

// The palette folder cannot be used: what is wrong, and what fixes it.
interface FolderProblem {
  message: string;
  fix: string;
}
const stillOff = "Until then, no palette can be used, but /tone-off still works.";
function folderIssue(error: unknown): FolderProblem {
  return error instanceof PlacementError
    ? { message: causeOf(error), fix: `Remove this copy of Pi Tone, install it from a folder that does not contain your palette folder and is not inside it, then run /reload. ${stillOff}` }
    : { message: `Your palette folder ${shown(paletteFolder())} cannot be used: ${causeOf(error)}`, fix: `Fix it, then run /reload. ${stillOff}` };
}

// The palette folder as the user configured it, for messages.
function paletteFolder(): string {
  return join(getAgentDir(), "pi-tone", "themes");
}

// The warning for a palette command whose text matches no palette of its command. A short list is
// shown when it reads unambiguously; otherwise Pi's completion list, which opens after the command and
// a space, shows the palettes whose names go on after a space.
function noMatch(command: string, args: string, candidates: ReadonlyMap<string, Candidate>): string {
  const typed = args === "" ? `/${command}` : `/${command} ${args}`;
  const names = [...candidates.values()].map(({ name }) => name);
  const spaced = [...candidates.keys()].some((key) => key !== "");
  const next = names.length <= 5 && !names.some((name) => name.includes(","))
    ? `Run ${names.length === 1 ? "this" : "one of these"} instead: ${names.map((name) => `/tone-${shown(name)}`).join(", ")}.`
    : !spaced ? `Run /${shown(command)} by itself.`
    : `Type /${shown(command)} and a space to choose a palette${candidates.has("") ? `, or run /${shown(command)} by itself` : ""}.`;
  return `There is no palette for ${shown(typed)}. ${next}`;
}

// Pi's /reload rebuilds the chat, so a message shown just before Pi Tone asks for a reload would disappear
// at once. The message is handed to the next runtime of this process through one in-memory slot instead.
// Nothing is written to disk, and the slot is empty again when the reload returns.
// - An error is shown by the next runtime when its session starts, and stays in the chat.
// - An info line would be replaced at once by Pi's own status line for the reload. So the next runtime
//   only leaves a way to show it, and the command shows it after the reload, as the newest status line.
// - Either way, the command lets the next runtime check after the reload whether Pi applied its own theme.
//   If not, the reload stopped early, and `unfinished` is shown as an error instead of an info line.
interface Handover {
  message: string;
  level: "info" | "error";
  // What to show as an error when Pi's reload stopped before Pi applied its own theme.
  unfinished?: string;
  show?: () => void;
}
const handoverKey = Symbol.for("pi-tone.after-reload");

function isHandover(value: unknown): value is Handover {
  return typeof value === "object" && value !== null
    && "message" in value && typeof value.message === "string"
    && "level" in value && (value.level === "info" || value.level === "error")
    && (!("unfinished" in value) || value.unfinished === undefined || typeof value.unfinished === "string")
    && (!("show" in value) || value.show === undefined || typeof value.show === "function");
}

function takeHandover(): Handover | undefined {
  const value: unknown = Reflect.get(globalThis, handoverKey);
  Reflect.deleteProperty(globalThis, handoverKey);
  return isHandover(value) ? value : undefined;
}

// Reload Pi from a command and show `handover` after the reload. If no new runtime of Pi Tone took it,
// `instead` is shown here while this context is still valid, as when Pi declined to reload; once Pi has
// ended this runtime, nothing more can be shown. Pi reports its own reload errors.
async function reloadShowing(ctx: ExtensionCommandContext, handover: Handover, instead: string): Promise<void> {
  Reflect.set(globalThis, handoverKey, handover);
  try { await ctx.reload(); } catch { /* Pi reports why it could not reload. */ }
  const left = takeHandover();
  if (left === undefined) return; // The next runtime showed it.
  if (left.show !== undefined) {
    try { left.show(); } catch { /* That runtime has ended as well, so the line cannot be shown. */ }
    return;
  }
  try { ctx.ui.notify(instead, "error"); } catch { /* This runtime has ended, so the message cannot be shown. */ }
}

// A runtime that ends while Pi's theme handling is paused leaves the theme on screen to the next runtime of
// this process: Pi Tone's own Theme object when it is one, otherwise that theme's colors object, which Pi
// also replaces when the terminal reports new colors. Pi installs a new theme object whenever it applies
// its own theme, so while the theme left is still on screen, Pi has not done so, for example because its
// reload stopped before that step, and the handling is still paused. Kept in memory only; the next session
// start takes it.
const pausedKey = Symbol.for("pi-tone.paused-theme");

function takePausedTheme(): { readonly colors: unknown } | undefined {
  const value: unknown = Reflect.get(globalThis, pausedKey);
  Reflect.deleteProperty(globalThis, pausedKey);
  return typeof value === "object" && value !== null && "colors" in value ? value : undefined;
}

const jsonSuffix = Buffer.from(".json");
const busyMessage = "Pi is still working. Run /tone-off again when Pi has finished its current work and queued messages.";
const reloadPending = "Pi has not finished reloading its theme. Fix any problem Pi reported and run /reload, then run the command again.";
const terminalTaken = "Another extension took over Pi's terminal output.";
const canvasRemoved = "Another extension removed the canvas.";
const themeTaken = "Another extension took over Pi's theme.";

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
  // A Theme object restores colors, not Pi's theme handling (such as following the terminal's light or
  // dark appearance). Keep this obligation until a reload or a successful palette with colors.
  let nativeRecoveryRequired = false;
  // Pi Tone gave Pi a Theme object in this runtime, which pauses Pi's theme handling until Pi applies its
  // own theme again, or this runtime saw that the pause from the previous runtime is still there. This stays
  // true even when something else replaces the colors later, such as a theme previewed in /settings, so
  // /tone-off still knows that a reload is needed.
  let themeHandlingPaused = false;
  // The theme that the previous runtime of this process left on screen with Pi's theme handling paused.
  let pausedTheme: { readonly colors: unknown } | undefined;
  let folderProblem: FolderProblem | undefined;

  const canvasKey = "pi-tone:canvas";
  interface CanvasState { owner: Theme; paint: CanvasAnsi; name: string; source: ThemeSource }
  interface CanvasBinding {
    tui: TUI;
    adapter: CanvasTerminal;
    ctx: ExtensionContext;
    state: CanvasState | undefined;
    live: boolean;
    checking: boolean;
    detach: () => void;
  }
  let canvasBinding: CanvasBinding | undefined;

  function clearCanvas(redraw = true): void {
    const binding = canvasBinding;
    if (!binding) return;
    canvasBinding = undefined;
    try { binding.detach(); } finally {
      try { binding.ctx.ui.setWidget(canvasKey, undefined, { placement: "belowEditor" }); } finally {
        // A full redraw replaces every painted cell with Pi's own output.
        if (redraw) binding.tui.requestRender(true);
      }
    }
  }

  // The canvas may paint only while it is current, Pi is in fullscreen mode with this adapter as its
  // terminal, and the canvas's own theme is shown.
  function canvasCurrent(binding: CanvasBinding): boolean {
    const { tui, adapter, ctx, state } = binding;
    if (canvasBinding !== binding || !binding.live || state === undefined) return false;
    try {
      return tui.terminal === adapter && tui.mode === "fullscreen" && ctx.ui.theme.colors === state.owner.colors;
    } catch {
      return false; // The context of an ended session: its cleanup removes the canvas.
    }
  }

  // How another extension took this canvas over, if it did: by removing it, which only another extension
  // can do while Pi Tone is drawing, or by replacing Pi's terminal output while the canvas was installed.
  function takeoverOf(binding: CanvasBinding): string | undefined {
    if (!binding.live) return canvasRemoved;
    return binding.tui.terminal === binding.adapter ? undefined : terminalTaken;
  }

  // Decide about a canvas that failed or may no longer paint. A newer theme owner wins quietly.
  // A failure, another terminal owner or regular mode stops the canvas, reported once.
  function reviewCanvas(binding: CanvasBinding): void {
    const { tui, adapter, ctx, state } = binding;
    if (canvasBinding !== binding || !binding.live || state === undefined) return;
    let owns: boolean;
    try { owns = ctx.ui.theme.colors === state.owner.colors; } catch { return; }
    const command = `/tone-${shown(state.name)}`;
    const off = " Or run /tone-off to turn Pi Tone off.";
    try {
      if (!owns) clearCanvas();
      else if (adapter.error !== undefined) {
        // What the canvas could not paint around may still be on screen, so it can stop again.
        failCanvas(binding, causeOf(adapter.error), validCanvasDimensions(tui.terminal.columns, tui.terminal.rows)
          ? `Run ${command} to try again. If the canvas stops again, choose a palette without a canvas, or run /tone-off to turn Pi Tone off.`
          : `Resize the terminal, then run ${command}.${off}`);
      } else if (tui.terminal !== adapter) {
        failCanvas(binding, terminalTaken, `Run ${command} to try again.${off}`);
      } else if (tui.mode !== "fullscreen") {
        failCanvas(binding, "Pi switched to regular mode, and a canvas works only in fullscreen mode.",
          `Switch back to fullscreen mode in /settings, then run ${command}.${off}`);
      }
    } catch (error) {
      ctx.ui.notify(`Could not remove the canvas of ${describe(state.name, state.source)}: ${causeOf(error)} Run /reload.`, "error");
    }
  }

  // Review a canvas after the current render or terminal write, never inside it.
  function checkCanvas(binding: CanvasBinding): void {
    if (binding.checking) return;
    binding.checking = true;
    queueMicrotask(() => {
      binding.checking = false;
      reviewCanvas(binding);
    });
  }

  // Stop a canvas that cannot keep painting. Its palette's colors go with it, because they were chosen
  // for the canvas background. The saved selection stays, so the palette can be tried again.
  function failCanvas(binding: CanvasBinding, reason: string, retry: string): void {
    const { tui, ctx, state } = binding;
    if (state === undefined) return;
    let outcome: string;
    try {
      clearCanvas(false);
      let restored = false;
      if (baseline !== undefined && active !== undefined && ctx.ui.theme.colors === active.colors) {
        replaceTheme(merge(baseline, { colors: {} }), active, baseline, ctx);
        nativeRecoveryRequired = true;
        restored = true;
      }
      outcome = `${restored ? "Pi's colors are back, and your" : "Your"} saved selection did not change. ${retry}`;
    } catch (error) {
      outcome = `Pi Tone also could not put Pi's colors back: ${causeOf(error)} Run /reload.`;
    }
    tui.requestRender(true);
    ctx.ui.notify(`Pi Tone stopped the canvas of ${describe(state.name, state.source)}: ${reason} ${outcome}`, "error");
  }

  function acquireCanvas(ctx: ExtensionContext, command: string): CanvasBinding {
    const current = canvasBinding;
    if (current !== undefined) {
      if (current.live && current.tui.terminal === current.adapter && current.tui.mode === "fullscreen") {
        requireCanvasHost(current.tui, command);
        return current;
      }
      clearCanvas(false); // A canvas left behind by a mode switch or another terminal owner is replaced.
    }
    try {
      ctx.ui.setWidget(canvasKey, (tui: TUI) => {
        requireCanvasHost(tui, command);
        const original = tui.terminal;
        const adapter: CanvasTerminal = new CanvasTerminal(original, () => {
          const binding = canvasBinding;
          return binding !== undefined && binding.adapter === adapter && canvasCurrent(binding);
        }, () => {
          const binding = canvasBinding;
          if (binding !== undefined && binding.adapter === adapter) checkCanvas(binding);
        });
        const binding: CanvasBinding = {
          tui, adapter, ctx, state: undefined, live: true, checking: false,
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
        if (tui.terminal !== adapter) throw new Problem("Pi did not accept the canvas.", `Run /reload, then run ${command}.`);
        return {
          // Pi renders this empty widget with every frame, so a canvas that has to stop is noticed even
          // when its output no longer passes through the adapter.
          render: () => {
            if (binding.state !== undefined && !canvasCurrent(binding)) checkCanvas(binding);
            return [];
          },
          invalidate: () => {},
          dispose: binding.detach,
        };
      }, { placement: "belowEditor" });
      if (!canvasBinding) throw new Problem("Pi did not create the canvas.", `Run /reload, then run ${command}.`);
      return canvasBinding;
    } catch (error) {
      try { clearCanvas(); } catch {
        throw new Problem(`${problemOf(error, command).message} Pi Tone also could not remove the unfinished canvas.`, runReload);
      }
      throw error;
    }
  }

  function configureCanvas(binding: CanvasBinding, state: CanvasState | undefined, command: string): void {
    const taken = takeoverOf(binding);
    if (taken !== undefined) throw new Problem(taken, `Run ${command} to try again.`);
    if (!binding.adapter.atBoundary) throw new Problem("Pi was in the middle of drawing the screen.", `Run ${command} to try again.`);
    binding.adapter.configure(state?.paint);
    binding.state = state;
  }

  function drawCanvas(binding: CanvasBinding, requireCanvas: boolean, command: string): void {
    const count = binding.adapter.paintedFrames;
    binding.tui.renderNow(true);
    if (!requireCanvas) return;
    const { error } = binding.adapter;
    const retry = `Run ${command} to try again, or choose a palette without a canvas.`;
    // In the order a running canvas is stopped in: its own failure first, then another owner of the terminal.
    if (error !== undefined) throw new Problem(causeOf(error), retry);
    // A canvas that is no longer Pi's terminal output cannot keep painting, whatever it painted before.
    const taken = takeoverOf(binding);
    if (taken !== undefined) throw new Problem(taken, `Run ${command} to try again.`);
    // Nor can one whose theme another extension replaced while Pi drew.
    const { state } = binding;
    if (state !== undefined && binding.ctx.ui.theme.colors !== state.owner.colors) throw new Problem(themeTaken, `Run ${command} to try again.`);
    if (binding.adapter.paintedFrames === count || !binding.adapter.fullGridPainted) {
      throw new Problem("Pi did not draw a full screen that the canvas could paint.", retry);
    }
  }

  // Resolve the name again for every use. A present user file owns the name even when it cannot be
  // used; only its absence lets the built-in palette of the same name be used.
  function readTone(candidate: Candidate): PreparedTone {
    const { name } = candidate;
    const command = `/tone-${shown(name)}`;
    requireToneName(name);
    if (folderProblem !== undefined) throw new Problem(folderProblem.message, folderProblem.fix);
    let directory: string | undefined;
    try { directory = userThemeDirectory(); } catch (error) {
      const problem = folderIssue(error);
      throw new Problem(problem.message, problem.fix);
    }
    if (directory !== undefined) {
      const file = `${name}.json`;
      const path = join(directory, file);
      const fileProblem = (message: string, fix: string): Problem => new Problem(message, fix, "user", path);
      // Only an entry with exactly this name counts, compared as bytes like discovery. On file systems
      // that ignore letter case, looking up dark.json would also find Dark.json or dark.JSON.
      let present: boolean;
      try {
        const wanted = Buffer.from(file);
        present = readdirSync(directory, { encoding: "buffer" }).some((entry) => entry.equals(wanted));
      } catch (error) {
        if (!missing(error)) {
          const problem = folderIssue(error);
          throw new Problem(problem.message, problem.fix);
        }
        present = false; // The folder was removed since the check above: there is no user palette.
      }
      let stat: ReturnType<typeof lstatSync> | undefined;
      if (present) {
        try { stat = lstatSync(path); } catch (error) {
          if (!missing(error)) throw fileProblem(causeOf(error), `Fix the file, then run ${command}.`);
        }
      }
      if (stat !== undefined) {
        if (stat.isSymbolicLink()) throw fileProblem("It is a link.", `Replace the link with the file itself, then run ${command}.`);
        if (!stat.isFile()) throw fileProblem("It is not a regular file.", `Replace it with a regular JSON file, then run ${command}.`);
        try {
          return { patch: parsePatch(readDocument(path), name), source: "user", path };
        } catch (error) {
          throw fileProblem(causeOf(error), `Fix the file, then run ${command}.`);
        }
      }
    }
    const document = builtInDocument(name);
    if (document === undefined) {
      throw new Problem(`${shown(name)}.json is no longer in your palette folder, and no built-in palette has that name.`,
        `Put the file back, then run ${command}. Or run /reload to update the palette commands.`);
    }
    try {
      return { patch: parsePatch(document, name), source: "built-in" };
    } catch (error) {
      throw new Problem(causeOf(error), "Update Pi Tone, or choose another palette.", "built-in");
    }
  }

  // A palette that was read but does not fit this Pi version.
  function contentProblem(tone: PreparedTone, error: unknown, command: string): Problem {
    return tone.source === "user"
      ? new Problem(causeOf(error), `Fix the file, then run ${command}.`, "user", tone.path)
      : new Problem(causeOf(error), "Update Pi Tone, or choose another palette.", "built-in");
  }

  function cancelRestore(): void {
    selectionGeneration += 1;
    const cancel = cancelDeferredRestore;
    cancelDeferredRestore = undefined;
    cancel?.();
  }

  function replaceTheme(next: Theme, previous: Theme, base: Baseline, ctx: ExtensionContext): void {
    // Mark BEFORE invoking the host: it can disable its theme handling and then fail
    // without replacing any visible colors. Color-map equality cannot prove rollback.
    if (active === undefined || ctx.ui.theme.colors !== active.colors) nativeRecoveryRequired = true;
    themeHandlingPaused = true;
    try {
      // Pass a Theme object: the string overload persists the user's theme setting.
      const result = ctx.ui.setTheme(next);
      if (!result.success) throw new Error(result.error || "Pi could not apply the theme.");
      // Pi applies a theme synchronously and invalidates every component on the way, so another extension can
      // take Pi's theme over before this call returns.
      if (ctx.ui.theme.colors !== next.colors) throw new Error(themeTaken);
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
          // The caller tries to put the previous look back once more and says whether that worked.
          throw error;
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

  function holdingIsCurrent(ctx: ExtensionContext): boolean {
    return holdingTheme !== undefined && ctx.ui.theme.colors === holdingTheme.colors;
  }

  function busy(ctx: ExtensionContext): boolean {
    return !ctx.isIdle() || ctx.hasPendingMessages();
  }

  // Whether the theme that the previous runtime left with Pi's theme handling paused is still on screen,
  // so Pi has not applied its own theme since. This is asked by commands and when Pi Tone's own reload
  // returns, which come after Pi's theme step would have; a pause seen then is kept like a theme Pi Tone
  // gave Pi in this runtime, since a theme previewed in /settings later replaces the colors, not the pause.
  function pausedThemeCurrent(ctx: ExtensionContext): boolean {
    try {
      if (pausedTheme === undefined || ctx.ui.theme.colors !== pausedTheme.colors) return false;
    } catch { return false; }
    themeHandlingPaused = true;
    nativeRecoveryRequired = true;
    return true;
  }

  // Whether Pi's theme handling is paused because of Pi Tone, in this runtime or in the previous one.
  function handlingPaused(ctx: ExtensionContext): boolean {
    return themeHandlingPaused || pausedThemeCurrent(ctx);
  }

  // Pi has not applied its own theme since its last reload: the theme held for that reload is still on
  // screen, or the theme the previous runtime left is, because the reload stopped early. A palette applied
  // now would be applied over that theme instead of over Pi's own.
  function reloadUnfinished(ctx: ExtensionContext): boolean {
    return holdingIsCurrent(ctx) || pausedThemeCurrent(ctx);
  }

  // The theme on screen, as Pi Tone's own Theme object when it is one (a held theme is also `active`).
  function themeOnScreen(ctx: ExtensionContext): { readonly colors: unknown } {
    const colors = ctx.ui.theme.colors;
    for (const theme of [active, pausedTheme]) {
      if (theme !== undefined && theme.colors === colors) return theme;
    }
    return { colors };
  }

  function failureText(name: string, restoring: boolean, problem: Problem): string {
    const what = restoring ? `your saved palette ${shown(name)}` : describe(name, problem.source);
    const from = problem.path === undefined ? "" : ` from ${shown(problem.path)}`;
    return `Could not ${restoring ? "restore" : "apply"} ${what}${from}: ${problem.message} ${problem.fix}`;
  }

  // `offWorks` is false when this Pi version cannot run /tone-off, which needs the reload API. A restore runs
  // from an event, whose context cannot tell, so it counts on a Pi that can, as the verified Pi version can.
  function notifyFailure(ctx: ExtensionContext, name: string, restoring: boolean,
      result: { problem: Problem; nativeRecovery: boolean }, offWorks = true): void {
    // A fix that already asks for /reload also restores Pi's theme handling. Otherwise say what gives it
    // back for certain: /reload when no selection is saved or the saved one cannot be read; /tone-off
    // when a selection is saved, since /reload tries the saved palette again, and only after an update of
    // Pi when this Pi version cannot reload for /tone-off.
    let note = "";
    if (result.nativeRecovery && result.problem.fix !== runReload) {
      let saved: boolean | undefined;
      try { saved = readPreference() !== undefined; } catch { saved = undefined; }
      note = saved === undefined || (!saved && !offWorks) ? " Pi's theme handling stays paused until you run /reload."
        : !offWorks ? " Pi's theme handling stays paused until you update Pi and run /tone-off."
        : saved ? " Pi's theme handling stays paused; /tone-off gives it back."
        : " Pi's theme handling stays paused until you run /reload or /tone-off.";
    }
    ctx.ui.notify(`${failureText(name, restoring, result.problem)}${note}`, "error");
  }

  function apply(candidate: Candidate, ctx: ExtensionContext, prepared?: PreparedTone): ApplyResult {
    const { name } = candidate;
    const command = `/tone-${shown(name)}`;
    let reloadSafe = false;
    let tone: PreparedTone | undefined;
    try {
      if (typeof ctx.ui.getTheme !== "function" || typeof ctx.ui.setTheme !== "function") {
        throw new Problem("This Pi version does not let extensions change the theme.", "Update Pi.");
      }
      requireToneName(name);
      tone = prepared ?? readTone(candidate);
      const { patch, source } = tone;
      // A canvas that failed or can no longer paint is settled first, as its next frame would do, so
      // it is never part of the look that is kept or put back.
      const stale = canvasBinding;
      if (stale !== undefined && (!canvasCurrent(stale) || stale.adapter.error !== undefined)) reviewCanvas(stale);
      const ownTheme = active !== undefined && ctx.ui.theme.colors === active.colors;
      const empty = setsNothing(patch);
      if (empty && (!ownTheme || !baseline)) {
        clearCanvas();
        return { applied: true, source, empty, changed: false };
      }
      const base = ownTheme && baseline ? baseline : snapshot(ctx);
      let next: Theme;
      let paint: CanvasAnsi | undefined;
      try {
        next = merge(base, patch);
        // Validate and encode before changing anything. Omitted canvas means no canvas: not the
        // preceding palette's canvas, and not the canvas of a built-in palette with the same name.
        paint = patch.canvas === undefined ? undefined : {
          background: encodeBackground(parseColor(patch.canvas.background), next.getColorMode()),
          foreground: patch.canvas.foreground === undefined ? "" : encodeForeground(parseColor(patch.canvas.foreground), next.getColorMode()),
        };
      } catch (error) {
        throw contentProblem(tone, error, command);
      }
      const previous = ownTheme && active ? active : merge(base, { colors: {} });
      const previousColors = ctx.ui.theme.colors;
      const previousBase = baseline;
      const previousActive = active;
      const oldBinding = canvasBinding;
      const oldState = oldBinding?.state;
      // A refused mode, widget or terminal leaves the old theme untouched.
      const binding = paint ? acquireCanvas(ctx, command) : canvasBinding;
      try {
        if (binding) configureCanvas(binding, paint ? { owner: next, paint, name, source } : undefined, command);
        replaceTheme(next, previous, base, ctx);
        if (binding) drawCanvas(binding, paint !== undefined, command);
        if (!paint) clearCanvas(false);
        // Another extension can also take Pi's theme over while Pi draws or removes the canvas.
        if (ctx.ui.theme.colors !== next.colors) throw new Problem(themeTaken, `Run ${command} to try again.`);
      } catch (error) {
        // Another extension that removed the canvas or replaced Pi's terminal output during the change owns it now.
        let takenOver = binding !== undefined && takeoverOf(binding) !== undefined;
        // The previous canvas comes back only while it is still Pi Tone's: one that another extension took over
        // is never taken back, and its palette's colors go with it, as when a running canvas stops.
        const canvasBack = oldState !== undefined && oldBinding !== undefined && oldBinding.live && !takenOver;
        const back = oldState !== undefined && !canvasBack ? merge(base, { colors: {} }) : previous;
        // Put the whole previous look back; only the caller saves, and only after full success.
        // This is an in-memory operation, not a cross-process transaction.
        try {
          const current = ctx.ui.theme.colors;
          if (current !== next.colors && current !== previousColors && current !== previous.colors) {
            throw new Error("Another theme took over during the failed change.");
          }
          if (current === next.colors || back !== previous) {
            const result = ctx.ui.setTheme(back);
            if (!result.success) throw new Error("Pi rejected the previous theme.");
            if (ctx.ui.theme.colors !== back.colors) throw new Error("Another theme took over during the failed change.");
          }
          const colorsBack = ctx.ui.theme.colors;
          if (colorsBack === back.colors) {
            baseline = base;
            active = back;
          } else {
            baseline = previousBase;
            active = previousActive;
          }
          if (canvasBack) {
            configureCanvas(oldBinding, oldState, command);
            drawCanvas(oldBinding, true, command);
          } else {
            clearCanvas(false);
            // A restored snapshot also needs a full redraw to remove painted cells.
            binding?.tui.renderNow(true);
          }
          // Another extension can also take over during these redraws: then Pi's theme or terminal output is
          // not what Pi Tone put back, which is its restored canvas or the terminal the canvas was installed on.
          const terminalBack = canvasBinding?.adapter ?? binding?.adapter.original;
          if (ctx.ui.theme.colors !== colorsBack || (binding !== undefined && binding.tui.terminal !== terminalBack)) takenOver = true;
        } catch {
          // Never leave a failed adapter rewriting later output.
          try { clearCanvas(); } catch { /* The problem below already asks for /reload. */ }
          throw new Problem(`${problemOf(error, command).message} Pi Tone also could not put the previous colors back.`,
            runReload, source, tone.path);
        }
        if (oldState !== undefined && !canvasBack) {
          // Pi's colors are shown without Pi's theme handling, as after a canvas that stops.
          nativeRecoveryRequired = true;
          const problem = problemOf(error, command);
          throw new Problem(`${problem.message} The canvas of ${describe(oldState.name, oldState.source)} stopped too, so Pi's colors are back, and your saved selection did not change.`,
            problem.fix, source, tone.path);
        }
        // Only a successful visual rollback with no other owner of Pi's theme or terminal output may lead to an
        // automatic reload; a conflicting owner or a failed rollback keeps the explicit guidance instead.
        reloadSafe = nativeRecoveryRequired && !takenOver;
        throw error;
      }
      // A palette that sets something now owns Pi's theme. An empty palette leaves Pi's colors without its theme handling.
      nativeRecoveryRequired = empty;
      return { applied: true, source, empty, changed: true };
    } catch (error) {
      const problem = problemOf(error, command);
      return {
        applied: false,
        problem: problem.source !== undefined || tone === undefined ? problem
          : new Problem(problem.message, problem.fix, tone.source, tone.path),
        nativeRecovery: nativeRecoveryRequired,
        reloadSafe,
      };
    }
  }

  // Discovery reads only names and file types. File names are read as bytes, so a name that is not
  // valid UTF-8 is reported instead of being turned into a different name.
  for (const name of builtInPalettes.keys()) byName.set(name, { name });
  const blockedNames = new Set<string>();
  try {
    const directory = userThemeDirectory(); // No palette folder is the normal first-install state.
    for (const entry of directory === undefined ? [] : readdirSync(directory, { withFileTypes: true, encoding: "buffer" })) {
      // Only names ending in lowercase .json are palettes; other files are left alone without a message.
      if (!entry.name.subarray(-jsonSuffix.length).equals(jsonSuffix)) continue;
      let file: string;
      try { file = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(entry.name); } catch {
        warnings.push({ message: `Skipped ${shown(entry.name.toString("utf8"))} in your palette folder: Its name is not valid UTF-8 text. Rename the file, then run /reload.` });
        continue;
      }
      const name = file.slice(0, -5);
      const problem = filenameError(file);
      const message = problem !== undefined ? `${problem} Rename the file, then run /reload.`
        : entry.isSymbolicLink() ? "It is a link. Replace the link with the file itself, then run /reload."
        : !entry.isFile() ? "It is not a regular file. Replace it with a regular JSON file, then run /reload."
        : undefined;
      if (message === undefined) {
        byName.set(name, { name }); // Exact names deduplicate; sources are never merged.
      } else {
        warnings.push({ name, message: `Skipped ${shown(file)} in your palette folder: ${message}` });
        blockedNames.add(name); // A file meant as a palette must not let a built-in of the same name take its place.
      }
    }
  } catch (error) {
    // Unknown folder contents must not expose a built-in palette that a user file may replace.
    folderProblem = folderIssue(error);
    warnings.push({ folder: true, message: `${folderProblem.message} ${folderProblem.fix}` });
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
    description: "Turn Pi Tone off, clear the saved palette, and give theme handling back to Pi.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (args !== "") {
        ctx.ui.notify("/tone-off takes no arguments. Run /tone-off by itself.", "warning");
        return;
      }
      if (typeof ctx.ui.setTheme !== "function" || typeof ctx.reload !== "function") {
        ctx.ui.notify("Could not turn Pi Tone off, because this Pi version does not let extensions change the theme or reload. Update Pi, then run /tone-off again.", "error");
        return;
      }
      // Pi refuses to reload during a response or compaction. Never abort user work to turn Pi Tone off.
      if (busy(ctx)) {
        ctx.ui.notify(busyMessage, "warning");
        return;
      }
      // Wait for a restore that is checking the terminal colors, so Off does not reload without need.
      // A theme still held for Pi's reload is dropped instead: Off then reloads Pi itself.
      const generation = ++selectionGeneration;
      const pending = nativeReady;
      if (pending !== undefined && !holdingIsCurrent(ctx)) await pending;
      if (generation !== selectionGeneration) return; // A newer command or the end of the session took over.
      if (busy(ctx)) {
        ctx.ui.notify(busyMessage, "warning");
        return;
      }
      const discardHolding = holdingIsCurrent(ctx);
      cancelRestore();
      try { clearCanvas(); } catch (error) {
        ctx.ui.notify(`Could not turn Pi Tone off, because its canvas could not be removed: ${causeOf(error)} Your saved selection was not cleared. Run /reload, then run /tone-off again.`, "error");
        return;
      }
      let restored = false;
      try {
        if (!discardHolding && baseline && active && ctx.ui.theme.colors === active.colors) {
          try {
            replaceTheme(merge(baseline, { colors: {} }), active, baseline, ctx);
            restored = true;
          } catch (error) {
            // Another extension that took Pi's theme over meanwhile replaced the palette as well, so Off goes on.
            if (!(error instanceof Error) || error.message !== themeTaken) throw error;
          }
          nativeRecoveryRequired = true; // Pi's theme handling is still paused.
        }
      } catch (error) {
        ctx.ui.notify(`Could not turn Pi Tone off, because Pi's colors could not be put back: ${causeOf(error)} Your saved selection was not cleared. Run /reload, then run /tone-off again.`, "error");
        return;
      }
      try {
        clearPreference();
      } catch (error) {
        ctx.ui.notify(`Could not finish turning Pi Tone off, because your saved selection in ${shown(preferenceFile())} could not be deleted: ${causeOf(error)} ${restored ? "Pi's colors are back for now. " : ""}Delete that file yourself, then run /tone-off again. Until then, /reload or a restart can bring the palette back or report an error.`, "error");
        return;
      }
      if (!handlingPaused(ctx)) {
        ctx.ui.notify("Pi Tone is off and your saved selection is cleared. No colors needed to change.", "info");
        return;
      }
      // Pi's reload restores its theme handling without writing settings or using private APIs. Pi reports
      // its own reload problems; the line below does not claim that the reload finished.
      await reloadShowing(ctx, {
        message: "Pi Tone is off and your saved selection is cleared.", level: "info",
        unfinished: "Pi Tone is off and your saved selection is cleared, but Pi's reload stopped before Pi applied its theme, so its theme handling is still paused. Fix the problem Pi reported, then run /reload.",
      }, "Pi Tone is off and your saved selection is cleared, but Pi did not reload, so its theme handling is still paused. Run /reload.");
    },
  });

  for (const [command, candidates] of groups) {
    const only = candidates.size === 1 ? [...candidates.values()][0] : undefined;
    // Discovery data only: never cache palette contents, paths or safety checks.
    const completions = [...candidates.entries()]
      .filter(([args]) => args !== "")
      .map(([args, { name }]) => ({ value: args, label: `/tone-${name}` }));
    pi.registerCommand(command, {
      description: only
        ? `Apply the ${only.name} palette and save it as your selection.`
        : `Apply ${candidates.has("") ? `the ${command.slice(5)} palette, or ` : ""}a palette named ${command.slice(5)} followed by a space and more text, and save it as your selection.`,
      getArgumentCompletions: (prefix) => {
        // Pi shows these as they are. Like Pi's own suggestions they ignore letter case; those that start with the
        // text as typed come first, so a whole name typed is the highlighted one. Spaces still count, and the
        // command itself still needs the exact name.
        const folded = prefix.toLowerCase();
        const typed: { value: string; label: string }[] = [];
        const other: { value: string; label: string }[] = [];
        for (const item of completions) {
          if (item.value.startsWith(prefix)) typed.push({ ...item });
          else if (item.value.toLowerCase().startsWith(folded)) other.push({ ...item });
        }
        const items = [...typed, ...other];
        return items.length === 0 ? null : items;
      },
      handler: async (args, ctx) => {
        if (ctx.mode !== "tui") return;
        const candidate = candidates.get(args);
        if (candidate === undefined) {
          ctx.ui.notify(noMatch(command, args, candidates), "warning");
          return;
        }
        if (reloadUnfinished(ctx)) {
          ctx.ui.notify(reloadPending, "warning");
          return;
        }
        // Wait for a restore that is checking the terminal colors, so the new baseline is Pi's final theme.
        const generation = ++selectionGeneration;
        const pending = nativeReady;
        if (pending !== undefined) await pending;
        if (generation !== selectionGeneration) return; // A newer command or the end of the session took over.
        if (holdingIsCurrent(ctx)) {
          ctx.ui.notify(reloadPending, "warning");
          return;
        }
        cancelRestore();
        const result = apply(candidate, ctx);
        if (!result.applied) {
          let reloading = false;
          // Do not bring back an older saved palette or loop on a failed one. Only a command can reload,
          // and only when no selection is saved.
          if (result.nativeRecovery && result.reloadSafe && typeof ctx.reload === "function" && !busy(ctx)) {
            try { reloading = readPreference() === undefined; } catch { /* Keep the explicit guidance. */ }
          }
          if (!reloading) {
            notifyFailure(ctx, candidate.name, false, result, typeof ctx.reload === "function");
            return;
          }
          cancelRestore();
          const text = failureText(candidate.name, false, result.problem);
          // Shown when the next runtime starts, before Pi has finished the reload, so it does not claim success.
          await reloadShowing(ctx, {
            message: `${text} The selection was not saved, and Pi Tone asked Pi to reload to restore its theme handling.`, level: "error",
            unfinished: "Pi's reload stopped before Pi applied its theme, so Pi's theme handling is still paused. Fix the problem Pi reported, then run /reload.",
          }, `${text} The selection was not saved. Run /reload to restore Pi's theme handling.`);
          return;
        }
        try {
          savePreference(candidate.name);
        } catch (error) {
          const fix = error instanceof Problem ? error.fix
            : `Make sure Pi Tone can write that file and its folder, then run /tone-${shown(candidate.name)} again.`;
          ctx.ui.notify(`Applied ${describe(candidate.name, result.source)} for this session, but could not save it as your selection in ${shown(preferenceFile())}: ${causeOf(error)} ${fix}`, "error");
          return;
        }
        const what = result.source === "user"
          ? `your palette ${shown(candidate.name)} from your palette folder` : `the built-in palette ${shown(candidate.name)}`;
        ctx.ui.notify(!result.empty ? `Applied ${what}.`
          : result.changed ? `Applied ${what}. It sets no colors, so Pi's colors are back. Pi's theme handling stays paused until you run /reload.`
          : `Applied ${what}. It sets no colors, so nothing changed.${themeHandlingPaused ? " Pi's theme handling stays paused until you run /reload." : ""}`, "info");
      },
    });
  }

  // Find the saved palette at session start. A problem with it takes over the diagnostics of the same
  // file or of the palette folder in this per-event copy, so each cause is reported once. Later reloads
  // still report problems that remain. Names are compared in full.
  function savedCandidate(diagnostics: Diagnostic[]): Candidate | undefined {
    let name: string | undefined;
    try {
      name = readPreference();
    } catch (error) {
      const fix = error instanceof Problem ? error.fix : "Fix or delete that file, then run /reload.";
      diagnostics.unshift({ message: `Could not read your saved selection in ${shown(preferenceFile())}: ${causeOf(error)} ${fix}` });
      return undefined;
    }
    if (name === undefined) return undefined;
    const saved = `your saved palette ${shown(name)}`;
    const take = (match: (item: Diagnostic) => boolean): Diagnostic[] => {
      const taken = diagnostics.filter(match);
      const kept = diagnostics.filter((item) => !match(item));
      diagnostics.splice(0, diagnostics.length, ...kept);
      return taken;
    };
    const problem = filenameError(`${name}.json`);
    if (problem !== undefined) {
      const file = take((item) => item.name === name).length > 0;
      diagnostics.unshift({ message: file
        ? `Could not restore ${saved}. Skipped ${shown(name)}.json in your palette folder: ${problem} Rename the file and run /reload, then choose the palette again. Or run /tone-off to clear the selection.`
        : `Could not restore ${saved}: ${problem} Choose another palette, or run /tone-off to clear the selection.` });
      return undefined;
    }
    if (folderProblem !== undefined) {
      take((item) => item.folder === true);
      diagnostics.unshift({ message: `Could not restore ${saved}. ${folderProblem.message} ${folderProblem.fix}` });
      return undefined;
    }
    const related = take((item) => item.name === name);
    if (related.length > 0) {
      diagnostics.unshift({ message: `Could not restore ${saved}. ${related.map((item) => item.message).join(" ")}` });
      return undefined;
    }
    const candidate = byName.get(name);
    if (candidate === undefined) {
      diagnostics.unshift({ message: `Could not restore ${saved}: It is not a built-in palette, and your palette folder has no ${shown(name)}.json. Put the file in ${shown(paletteFolder())} and run /reload, choose another palette, or run /tone-off to clear the selection.` });
      return undefined;
    }
    return candidate;
  }

  function deferRestore(candidate: Candidate, ctx: ExtensionContext): void {
    cancelRestore();
    const generation = selectionGeneration;
    const command = `/tone-${shown(candidate.name)}`;
    const saved = `your saved palette ${shown(candidate.name)}`;
    const widgetKey = "pi-tone:restore-saved";
    let live = true;
    let queued = false;
    let resolveReady: (ready: boolean) => void = () => {};

    // A colors object can change on a terminal reply without a theme replacement.
    // Keep a concrete, visually identical Theme as an identity witness instead.
    // Comparing against witness.colors on each render survives those cache changes.
    let prepared: PreparedTone;
    let witness: Theme;
    try {
      prepared = readTone(candidate);
      const tone = prepared;
      const { patch } = tone;
      if (setsNothing(patch)) return; // Pi's own reset is enough.
      if (patch.canvas) {
        let capable = false;
        try {
          ctx.ui.setWidget(widgetKey, (tui) => {
            requireCanvasHost(tui, command);
            capable = true;
            return { render: () => [], invalidate: () => {} };
          });
          if (!capable) throw new Problem("Pi did not let Pi Tone check for fullscreen mode.", `Run /reload, then run ${command}.`);
        } finally { ctx.ui.setWidget(widgetKey, undefined); }
      }
      const before = snapshot(ctx);
      try { merge(before, patch); } catch (error) { throw contentProblem(tone, error, command); } // Check every role before changing anything.
      witness = merge(before, { colors: {} });
      replaceTheme(witness, merge(before, { colors: {} }), before, ctx);
      holdingTheme = witness;
    } catch (error) {
      // Pi applies its own theme right after this event, which also gives its theme handling back.
      nativeRecoveryRequired = false;
      themeHandlingPaused = false;
      notifyFailure(ctx, candidate.name, true, { problem: problemOf(error, command), nativeRecovery: false });
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
        // Pi applied its own theme after the reload. The holding theme is never a baseline for the
        // restored palette.
        baseline = undefined;
        active = undefined;
        holdingTheme = undefined;
        nativeRecoveryRequired = false;
        themeHandlingPaused = false;
      }
      if (removeWidget) ctx.ui.setWidget(widgetKey, undefined);
      resolveReady(success);
    }
    cancelDeferredRestore = () => settle(false, true);
    void ready.then((success) => {
      if (!success || generation !== selectionGeneration) return;
      const result = apply(candidate, ctx, prepared);
      if (!result.applied) notifyFailure(ctx, candidate.name, true, result);
    });

    try {
      ctx.ui.setWidget(widgetKey, (tui) => ({
        render: () => {
          if (live && !queued && ctx.ui.theme.colors !== witness.colors) {
            queued = true;
            queueMicrotask(async () => {
              if (!live) return;
              // Pi sends its own color query in the same reset. Replies complete queries in the order they
              // were sent, and this query has the same 100 ms timeout as Pi's, so it ends after Pi's query has
              // applied its colors, also when the terminal answers nothing: a completion barrier, not a delay.
              try {
                await tui.queryTerminalColors({ timeoutMs: 100 });
              } catch (error) {
                if (!live) return;
                settle(false, true);
                ctx.ui.notify(`Could not restore ${saved}, because Pi could not finish checking the terminal colors: ${causeOf(error)} Run /reload.`, "error");
                return;
              }
              if (!live) return;
              if (ctx.ui.theme.colors === witness.colors) {
                settle(false, true);
                ctx.ui.notify(`Could not restore ${saved}, because Pi did not load its own theme after the reload. Run /reload.`, "error");
                return;
              }
              settle(true, true);
            });
          }
          return [];
        },
        invalidate: () => {},
        dispose: () => settle(false, false),
      }));
    } catch (error) {
      settle(false, false);
      ctx.ui.notify(`Could not restore ${saved}: ${causeOf(error)} Run /reload.`, "error");
    }
  }

  pi.on("session_start", (event, ctx) => {
    // RPC also supports notify(), so hasUI alone is not a TUI-only guard.
    // Stay silent and do not read preferences or change theme state outside TUI.
    if (ctx.mode !== "tui") return;
    cancelRestore();
    try { clearCanvas(); } catch (error) {
      ctx.ui.notify(`Could not remove a canvas left from before: ${causeOf(error)} Run /reload.`, "error");
    }

    // Fresh startup follows Pi's first color query. A reload or a new session applies Pi's settings
    // after session_start, so a held theme and a public terminal query come first. No host patching.
    baseline = undefined;
    active = undefined;
    holdingTheme = undefined;
    nativeRecoveryRequired = false;
    themeHandlingPaused = false;
    // Pi applies its own theme after this event, except at startup. Until it does, a theme that the
    // previous runtime left with Pi's theme handling paused stays on screen.
    pausedTheme = takePausedTheme();
    // A message from the runtime that asked for this reload: an error is shown now, before anything else;
    // an info line is left for that runtime to show after Pi's own status line for the reload. That runtime
    // calls show() when the reload returns: if the theme it left is still on screen, the reload stopped
    // before Pi applied its own theme, and `unfinished` says that Pi's theme handling is still paused.
    const handed = event.reason === "reload" ? takeHandover() : undefined;
    if (handed !== undefined) {
      if (handed.level === "error") ctx.ui.notify(handed.message, "error");
      const { message, level, unfinished } = handed;
      Reflect.set(globalThis, handoverKey, { message, level, show: () => {
        const stopped = pausedThemeCurrent(ctx);
        if (stopped && unfinished !== undefined) ctx.ui.notify(unfinished, "error");
        else if (level === "info") ctx.ui.notify(message, "info");
      } });
    }
    const diagnostics = [...warnings];
    const candidate = savedCandidate(diagnostics);
    if (diagnostics.length > 0) {
      const lines = diagnostics.slice(0, 10).map((item) => item.message);
      const more = diagnostics.length - lines.length;
      if (more > 0) {
        lines.push(`${more} more ${more === 1 ? "problem is" : "problems are"} not shown. Fix the ones above, then run /reload to see the rest.`);
      }
      ctx.ui.notify(lines.join("\n"), "error");
    }
    if (candidate === undefined) return;
    if (event.reason === "startup") {
      const result = apply(candidate, ctx);
      if (!result.applied) notifyFailure(ctx, candidate.name, true, result);
    } else deferRestore(candidate, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // The session is ending: Pi restores the terminal itself, and a message could not be shown.
    try { cancelRestore(); } catch { /* Nothing else to undo. */ }
    try { clearCanvas(); } catch { /* Nothing else to undo. */ }
    // While Pi's theme handling is paused, leave the theme on screen to the next runtime (see pausedKey).
    try {
      if (handlingPaused(ctx)) Reflect.set(globalThis, pausedKey, themeOnScreen(ctx));
    } catch { /* The next runtime then counts on Pi's own theme step. */ }
  });
}
