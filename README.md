# Pi Tone

## 1. Introduction

Pi Tone changes the colors of Pi's interactive terminal UI without touching terminal or Pi settings. Run `/tone-<filename>` to apply one palette: only the color roles it defines change, every other role keeps its original non-Tone Pi value, and one Tone never inherits another. A palette can also request a canvas that paints Pi's fullscreen background and default text.

Sixteen five-shade palettes are built into the program: neutral `dark` and `light`, plus Dark and Light variants of red, orange, yellow, green, blue, indigo, and purple. Your own palettes are JSON files in a separate user directory. A successful selection is remembered and restored after a restart or `/reload`; `/tone-off` clears it and returns theme management to Pi. Without a saved choice, installing Pi Tone changes nothing.

Pi Tone never edits terminal default colors or palettes, Pi's `settings.json`, or Pi's native themes, and it writes no temporary or merged theme files. Its only persistent write is the selected name. The canvas uses one removable wrapper around Pi's public `TUI.terminal`, limited to recognized fullscreen frames: an accepted, scoped exception, not an official Pi canvas API.

**Pi Tone 1.0.0** is verified against **Pi 1.5.0**. Author and copyright holder: `caeloren`. License: [Sustainable Use License 1.0](LICENSE) (`SUL-1.0`); the LICENSE file is authoritative. The package has four files, all at its top level: `LICENSE`, `README.md`, `package.json`, and `tone.ts`.

## 2. Usage

### 2.1 Install, update, and remove

Pi Tone runs in Pi's interactive TUI. Pi 1.5.0 installed through Node.js needs Node.js 22.19.0 or later. Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`; Pi Tone has no build step and no dependencies of its own.

Package commands run in a normal shell; `/tone-...` and `/reload` run in Pi's input editor.

```bash
pi install git:github.com/caeloren/pi-tone
pi update git:github.com/caeloren/pi-tone
pi remove git:github.com/caeloren/pi-tone
```

- Add `--local` or `-l` to declare the package for the current project; Pi's project trust decides whether it loads. The saved Tone is shared per agent directory either way, not per project.
- `git:github.com/caeloren/pi-tone@v1.0.0` pins a release. The tag must exist, and updates keep a pinned ref.
- A local copy installs with `pi install /absolute/path/to/pi-tone`. Pi loads it in place without copying, so keep the directory; update it by replacing its four files.
- `pi list` shows the configured source. Use that exact source with `pi update` and `pi remove`.
- After updating Pi Tone, run `/reload`. After updating Pi itself, exit and start a new Pi process.
- Run `/tone-off` before removing Pi Tone, so the saved choice is cleared; otherwise a later reinstall restores it. Removal never deletes your user palettes.
- To try Pi Tone for one session without installing it: `pi -e /absolute/path/to/pi-tone/tone.ts`.

**Palettes kept inside an older package.** Earlier builds shipped palette files in the package's own `themes/` directory. Before updating such an installation, copy every JSON you edited there into the user directory (section 2.3), keeping its file name and `name`. Package updates may delete files inside the package; `.gitignore` does not protect them, and Pi Tone cannot recover them afterwards. Unmodified copies of the sixteen palettes need no migration because they are built in now. Files left in a package `themes/` directory are no longer read.

### 2.2 Commands and file names

One rule maps every palette to its command:

```text
<filename>.json -> /tone-<filename>
```

| Palette | Command |
|---|---|
| Built-in `dark` | `/tone-dark` |
| Built-in `red-dark` | `/tone-red-dark` |
| `soft.json` | `/tone-soft` |
| `soft gray.json` | `/tone-soft gray` |
| `soft  gray.json` (two spaces) | `/tone-soft  gray` |
| `version 2 (warm).json` | `/tone-version 2 (warm)` |
| `柔和 色.json` | `/tone-柔和 色` |
| `tone-blue.json` | `/tone-tone-blue` |

Names match exactly: no case changes, prefix removal, space compression, fuzzy matching, or shell-style quoting. Pi splits a command at its first space, so `/tone-soft gray` runs `/tone-soft` with the argument `gray`; Pi Tone matches that argument exactly, so one and two spaces are different names. Argument completion offers matching names by prefix. `/tone-dark extra` means a file named `dark extra.json`, not an argument to `dark`.

`/tone-off` is the only control command; there is no `/tone` menu and no `--help`. Names in its command group, such as `off.json` and `off gray.json`, are reserved and skipped. `off-blue.json`, `off_gray.json`, `Off.json`, and `tone-off.json` are ordinary palettes.

A user palette is a regular file whose name ends in lowercase `.json`. Other entries in the user directory are handled like this:

| Entry | Result |
|---|---|
| Supported name, regular file | Registered without reading its content |
| `.json`, an all-whitespace stem, `.hidden.json` | Warned and skipped |
| `theme.v2.json` (another period in the stem) | Warned and skipped |
| `@gray.json`, `soft@gray.json` (`@` anywhere) | Warned and skipped; `@` stays reserved for Pi's file references |
| `trailing .json` (trailing whitespace) | Warned and skipped |
| Path separators, control characters, line or paragraph separators, `Bidi_Control` characters | Warned and skipped |
| Directory or symbolic link named `*.json` | Warned and skipped; it also hides a built-in palette of the same name |
| `dark.JSON`, `notes.txt`, `soft.json.bak` | Ignored silently |

The rejected characters are U+0000–U+001F, U+007F–U+009F, U+2028–U+2029, and the complete `Bidi_Control` set: U+061C, U+200E–U+200F, U+202A–U+202E, and U+2066–U+2069. Visible Arabic, Hebrew, Chinese, and other Unicode text is allowed. Leading spaces are allowed but awkward to type. Saved names follow the same rules. This is not a complete detector of confusable characters.

Startup and `/reload` read only file names and types. A palette's content is read when you apply it, or when it is restored as the saved choice.

| Change | What to do |
|---|---|
| Edit or repair the content of a registered palette | Run its command again |
| Add, rename, or remove a palette, or fix a rejected file name | Run `/reload`; a renamed file also needs a matching `name` |
| Add or remove a user file that shadows a built-in name | Nothing; the next application decides again |
| Edit the remembered palette | The next startup or `/reload` rereads it |

There is no file watcher. A deleted user palette keeps its command until `/reload`; running it then falls back to the built-in palette of the same name, or reports that the file is missing.

### 2.3 Where palettes and the saved choice live

| Location | Contents |
|---|---|
| Built into `tone.ts` | The sixteen palettes of section 2.6, updated with the package |
| `<agent>/pi-tone/themes/` | Your palettes. Pi Tone never creates, edits, copies, migrates, or deletes files here |
| `<agent>/pi-tone.json` | The saved palette name |

`<agent>` is Pi's agent directory: `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when it is set. All projects and package copies using that directory share it. It is separate from Pi's native `<agent>/themes/`.

**A user palette always wins over a built-in palette of the same name.** `<agent>/pi-tone/themes/dark.json` replaces the built-in `dark` completely. The two are never merged: roles missing from your file come from your Pi theme, not from the built-in palette.

A user file that exists but is invalid, unreadable, or unsafe is reported, and Pi Tone never silently uses the built-in palette instead. A missing user directory is normal and is not created automatically. A user directory that cannot be inspected safely blocks every file-based application until you fix it and run `/reload`, because Pi Tone cannot prove that no user palette overrides the name; `/tone-off` keeps working.

Create the directory yourself when you add your first palette, in a normal shell:

```bash
mkdir -p "$HOME/.pi/agent/pi-tone/themes"
```

```powershell
New-Item -ItemType Directory -Force -Path (Join-Path $HOME ".pi/agent/pi-tone/themes")
```

With `PI_CODING_AGENT_DIR` set, use that directory followed by `pi-tone/themes`. Never install the package inside the user themes directory or in a directory that contains it, such as `<agent>/pi-tone/`: Pi Tone refuses that layout so that package updates cannot remove your palettes.

### 2.4 Write a palette

A palette is a UTF-8 JSON object; a byte-order mark is accepted. Comments, trailing commas, JSON5, and executable code are not supported.

| Property | Meaning |
|---|---|
| `name` | Required. Exactly the file name without `.json`, including case and spaces |
| `colors` | Roles to override (section 2.7). Missing or empty means no role overrides |
| `vars` | Reusable values local to this file; a variable may refer to another variable |
| `canvas` | Optional fullscreen canvas (section 2.5) |
| `appearance` | Optional `"dark"` or `"light"` marker passed to Pi; it does not switch files or follow the OS |
| `$schema` | Optional string; Pi Tone ignores it, an editor may use it |

`export` is rejected even when empty, and so is any other property.

| Value | Example |
|---|---|
| Hex RGB, three or six digits | `"#abc"`, `"#AABBCC"` |
| OKLCH | `"oklch(62% 0.1 200)"` |
| OKHSL | `"okhsl(250 60% 55%)"` |
| ANSI palette index, integer 0–255 | `39` |
| Variable | `"heading"` |
| Default channel | `""` |

Any other non-empty string is a variable name, so `"red"` works only when `vars` defines `red`. CSS color names, `rgb()`, alpha values, booleans, `null`, arrays, and objects are rejected. Every declared variable is validated, even when unused; missing and circular references fail. Role names are case-sensitive and must exist in the running Pi version. Any error rejects the whole file before anything changes.

For example, `<agent>/pi-tone/themes/soft headings.json`:

```json
{
  "name": "soft headings",
  "vars": { "neutral": "#D8D8D8", "heading": "neutral" },
  "colors": { "mdHeading": "heading", "mdLink": "heading" }
}
```

Run `/reload`, then `/tone-soft headings`. Only headings and links change. On a light Pi theme, choose a darker value.

**Each application starts from your Pi theme.** Applying Tone A and then Tone B gives your Pi theme plus B's roles, never A's. While Tones stay in control, Pi Tone reuses the Pi theme it captured before the first Tone; a restart, `/reload`, or session change captures it again. A role you omit keeps its own Pi value and is not recalculated from other roles.

**Omitting a role and setting it to `""` are different.** Omitting `border` keeps your Pi theme's border. `"border": ""` asks for the terminal's default foreground for borders, which a canvas can recolor (section 2.5). `"border": null` is an error.

**An empty palette is not Off.** A file without `colors` entries and without `canvas` changes nothing new: if a Tone is shown, it restores your Pi theme's colors, and either way its name is saved as the choice. Pi's own theme syncing returns only after a later native `/reload`. `/tone-off`, by contrast, deletes the saved choice.

### 2.5 Fullscreen canvas

Without a canvas, Pi Tone changes role colors only, and cells drawn in the terminal's default colors keep them. A `canvas` paints those cells in fullscreen mode:

```json
"canvas": { "background": "G0", "foreground": "G4" }
```

- `background` is required and `foreground` is optional. Both accept the values of section 2.4 except `""`. `canvas: null`, `canvas: {}`, and unknown keys are errors.
- A canvas is never inferred from a file name, `appearance`, or `G0`, and never carried over from the previous Tone.
- A canvas needs Pi's fullscreen mode, which is Pi's default (`--tui-mode fullscreen`, setting `tuiMode`). In regular mode a palette with `canvas` is rejected before any color changes and is not saved; Pi Tone does not switch modes for you. Palettes without `canvas` work in both modes.

| Inside a painted fullscreen frame | Shown as |
|---|---|
| Default background, including a role set to `""` | `canvas.background` |
| Default foreground, when `canvas.foreground` is set | `canvas.foreground` |
| Default foreground, without `canvas.foreground` | The terminal default |
| An explicit role color or panel background | That color, unchanged |

Default channels inherited from your Pi theme follow the same rule. The canvas changes only what is drawn: not the JSON, not the stored role values, and not the terminal's palette. Outside painted frames, terminal defaults stay terminal defaults. Padding outside the terminal's character grid belongs to the terminal and is not painted.

### 2.6 Built-in palettes

| Tone | Command | Appearance | G0 | G1 | G2 | G3 | G4 |
|---|---|---|---|---|---|---|---|
| `dark` | `/tone-dark` | Dark | `#101010` | `#1C1C1C` | `#727272` | `#A6A6A6` | `#FAFAFA` |
| `light` | `/tone-light` | Light | `#FAFAFA` | `#E8E8E8` | `#7D7D7D` | `#4F4F4F` | `#101010` |
| `red-dark` | `/tone-red-dark` | Dark | `#1E1312` | `#332120` | `#B6918D` | `#DABCB9` | `#FBEAE8` |
| `red-light` | `/tone-red-light` | Light | `#FFF2F0` | `#F0D8D6` | `#7B5956` | `#5A3E3B` | `#291918` |
| `orange-dark` | `/tone-orange-dark` | Dark | `#1C140D` | `#302418` | `#AF967F` | `#D5C0AD` | `#F7ECE2` |
| `orange-light` | `/tone-orange-light` | Light | `#FCF3EC` | `#EADACC` | `#755E48` | `#56422F` | `#261C11` |
| `yellow-dark` | `/tone-yellow-dark` | Dark | `#18160D` | `#292717` | `#A19C7D` | `#C9C5AC` | `#F1EFE2` |
| `yellow-light` | `/tone-yellow-light` | Light | `#F7F6EB` | `#E2DFCC` | `#696446` | `#4B472E` | `#211E10` |
| `green-dark` | `/tone-green-dark` | Dark | `#101812` | `#1D2A1F` | `#88A48D` | `#B5CBB8` | `#E6F2E8` |
| `green-light` | `/tone-green-light` | Light | `#EFF8F0` | `#D2E3D5` | `#516B56` | `#374D3B` | `#162118` |
| `blue-dark` | `/tone-blue-dark` | Dark | `#0F171D` | `#1A2832` | `#83A0B5` | `#B1C8D9` | `#E4F0FA` |
| `blue-light` | `/tone-blue-light` | Light | `#EDF7FE` | `#D0E1EF` | `#4C677B` | `#32495A` | `#132029` |
| `indigo-dark` | `/tone-indigo-dark` | Dark | `#14151E` | `#222534` | `#939AB8` | `#BDC3DB` | `#EBEEFB` |
| `indigo-light` | `/tone-indigo-light` | Light | `#F2F5FF` | `#D9DEF1` | `#5B627D` | `#40455C` | `#1A1D2A` |
| `purple-dark` | `/tone-purple-dark` | Dark | `#19141C` | `#2A2330` | `#A494B1` | `#CBBED6` | `#F2EBF8` |
| `purple-light` | `/tone-purple-light` | Light | `#F8F3FC` | `#E4DAEC` | `#6B5C77` | `#4D4057` | `#221B27` |

| Shade | Used for |
|---|---|
| `G0` | Canvas background and search-match background |
| `G1` | Message, tool, and selection backgrounds |
| `G2` | Code comments, removed diff lines, and ordinary or muted borders |
| `G3` | Secondary text, code strings and numbers, and the primary `accent` |
| `G4` | Main text and canvas foreground |

Every built-in palette sets all 56 roles of section 2.7 and a canvas of `G0` background and `G4` foreground. Each role has the same shade in all sixteen palettes, so they differ only in their five colors and their `appearance`. `borderAccent` is `G4` although `accent` is `G3`. Each Light palette's `G0`-to-`G1` step in OKLCH lightness matches its Dark counterpart's (`light` with `dark`, `red-light` with `red-dark`, and so on), so panels stand out as clearly in both. The five-shade structure applies only to the built-ins; your palettes can use any values.

To start your own palette from a built-in one, save the following as `<agent>/pi-tone/themes/example.json`, run `/reload`, and select `/tone-example`. It equals `blue-dark` apart from its name; change the five variables to recolor it.

```json
{
  "name": "example",
  "appearance": "dark",
  "vars": {
    "G0": "#0F171D",
    "G1": "#1A2832",
    "G2": "#83A0B5",
    "G3": "#B1C8D9",
    "G4": "#E4F0FA"
  },
  "colors": {
    "accent": "G3",
    "border": "G2",
    "borderAccent": "G4",
    "borderMuted": "G2",
    "success": "G3",
    "error": "G4",
    "warning": "G4",
    "muted": "G3",
    "dim": "G3",
    "text": "G4",
    "thinkingText": "G3",
    "selectedBg": "G1",
    "scrollbarTrack": "G2",
    "scrollbarThumb": "G4",
    "searchMatchBg": "G0",
    "searchMatchText": "G4",
    "userMessageBg": "G1",
    "userMessageText": "G4",
    "customMessageBg": "G1",
    "customMessageText": "G3",
    "customMessageLabel": "G4",
    "toolPendingBg": "G1",
    "toolSuccessBg": "G1",
    "toolErrorBg": "G1",
    "toolTitle": "G4",
    "toolOutput": "G3",
    "mdHeading": "G4",
    "mdLink": "G4",
    "mdLinkUrl": "G3",
    "mdCode": "G4",
    "mdCodeBlock": "G4",
    "mdCodeBlockBorder": "G3",
    "mdQuote": "G3",
    "mdQuoteBorder": "G2",
    "mdHr": "G2",
    "mdListBullet": "G4",
    "toolDiffAdded": "G4",
    "toolDiffRemoved": "G2",
    "toolDiffContext": "G3",
    "syntaxComment": "G2",
    "syntaxKeyword": "G4",
    "syntaxFunction": "G4",
    "syntaxVariable": "G4",
    "syntaxString": "G3",
    "syntaxNumber": "G3",
    "syntaxType": "G4",
    "syntaxOperator": "G3",
    "syntaxPunctuation": "G3",
    "thinkingOff": "G3",
    "thinkingMinimal": "G3",
    "thinkingLow": "G3",
    "thinkingMedium": "G4",
    "thinkingHigh": "G4",
    "thinkingXhigh": "G4",
    "thinkingMax": "G4",
    "bashMode": "G4"
  },
  "canvas": {
    "background": "G0",
    "foreground": "G4"
  }
}
```

Saving it as `blue-dark.json` with `"name": "blue-dark"` overrides the built-in `blue-dark` itself. A user copy stays exactly as you wrote it when the package updates; delete it to use the built-in palette again.

### 2.7 Color roles

Pi 1.5.0 has 56 TUI color roles. FG is a foreground role and BG a background role. A role can appear in several places; it is not a CSS selector and does not set fonts or layout.

#### General interface

| Role | Slot | Built-in shade | Use |
|---|---|---|---|
| `accent` | FG | `G3` | Primary accent |
| `border` | FG | `G2` | Ordinary borders |
| `borderAccent` | FG | `G4` | Emphasized borders |
| `borderMuted` | FG | `G2` | Low-emphasis borders |
| `success` | FG | `G3` | Success states |
| `error` | FG | `G4` | Error states |
| `warning` | FG | `G4` | Warning states |
| `muted` | FG | `G3` | Secondary text |
| `dim` | FG | `G3` | Low-emphasis text; a color, not a separate faint toggle |
| `text` | FG | `G4` | Body text |
| `thinkingText` | FG | `G3` | Displayed thinking text |

#### Selection, search, and scrollbar

| Role | Slot | Built-in shade | Use |
|---|---|---|---|
| `selectedBg` | BG | `G1` | Selected item |
| `scrollbarTrack` | FG | `G2` | Fullscreen scrollbar track |
| `scrollbarThumb` | FG | `G4` | Fullscreen scrollbar thumb |
| `searchMatchBg` | BG | `G0` | Transcript search match, before Pi inverts it |
| `searchMatchText` | FG | `G4` | Transcript search-match text, before Pi inverts it |

#### Messages and tools

| Role | Slot | Built-in shade | Use |
|---|---|---|---|
| `userMessageBg` | BG | `G1` | User-message panel |
| `userMessageText` | FG | `G4` | User-message text |
| `customMessageBg` | BG | `G1` | Custom-message panel |
| `customMessageText` | FG | `G3` | Custom-message text |
| `customMessageLabel` | FG | `G4` | Custom-message type label |
| `toolPendingBg` | BG | `G1` | Pending or running tool panel |
| `toolSuccessBg` | BG | `G1` | Successful tool panel |
| `toolErrorBg` | BG | `G1` | Failed tool panel |
| `toolTitle` | FG | `G4` | Tool name |
| `toolOutput` | FG | `G3` | Tool output |

#### Markdown

| Role | Slot | Built-in shade | Use |
|---|---|---|---|
| `mdHeading` | FG | `G4` | Headings |
| `mdLink` | FG | `G4` | Link labels |
| `mdLinkUrl` | FG | `G3` | Link URLs |
| `mdCode` | FG | `G4` | Inline code |
| `mdCodeBlock` | FG | `G4` | Code-block text; highlighting uses the syntax roles |
| `mdCodeBlockBorder` | FG | `G3` | Code-block fences |
| `mdQuote` | FG | `G3` | Blockquote text |
| `mdQuoteBorder` | FG | `G2` | Blockquote border |
| `mdHr` | FG | `G2` | Horizontal rules |
| `mdListBullet` | FG | `G4` | List bullets and numbers |

#### Tool diffs

| Role | Slot | Built-in shade | Use |
|---|---|---|---|
| `toolDiffAdded` | FG | `G4` | Added lines, marked `+` |
| `toolDiffRemoved` | FG | `G2` | Removed lines, marked `-` |
| `toolDiffContext` | FG | `G3` | Unchanged context |

#### Syntax highlighting

| Role | Slot | Built-in shade | Use |
|---|---|---|---|
| `syntaxComment` | FG | `G2` | Comments |
| `syntaxKeyword` | FG | `G4` | Keywords |
| `syntaxFunction` | FG | `G4` | Function names |
| `syntaxVariable` | FG | `G4` | Variable names |
| `syntaxString` | FG | `G3` | Strings and regular expressions |
| `syntaxNumber` | FG | `G3` | Numbers and literals such as `true` and `null` |
| `syntaxType` | FG | `G4` | Type names |
| `syntaxOperator` | FG | `G3` | Operators |
| `syntaxPunctuation` | FG | `G3` | Punctuation |

Pi colors only the parts of code its highlighter marks. Most languages leave operators and punctuation unmarked, so they appear in the default foreground, like unmarked names.

#### Thinking levels and Bash mode

| Role | Slot | Built-in shade | Use |
|---|---|---|---|
| `thinkingOff` | FG | `G3` | Editor indicator and border, thinking off |
| `thinkingMinimal` | FG | `G3` | Editor indicator and border, minimal thinking |
| `thinkingLow` | FG | `G3` | Editor indicator and border, low thinking |
| `thinkingMedium` | FG | `G4` | Editor indicator and border, medium thinking |
| `thinkingHigh` | FG | `G4` | Editor indicator and border, high thinking |
| `thinkingXhigh` | FG | `G4` | Editor indicator and border, xhigh thinking |
| `thinkingMax` | FG | `G4` | Editor indicator and border, max thinking |
| `bashMode` | FG | `G4` | Editor border in Bash mode |

### 2.8 Saved choice and restoration

A successful selection you make saves only its name, in `<agent>/pi-tone.json`:

```json
{
  "tone": "blue-dark"
}
```

No path, source, colors, or baseline are stored, and every restoration resolves the name again, user directory first. An identical choice is not rewritten.

| Situation | Result |
|---|---|
| No saved choice | Pi's colors are left alone |
| Pi starts | The saved palette is read and applied after Pi's own theme setup |
| `/reload`, or a new, resumed, or forked session | The palette is applied after Pi has replaced its theme and its terminal-color query has a reply or reaches Pi's 100 ms timeout |
| The saved palette is missing or invalid | One warning; Pi's colors stay in effect and nothing is rewritten |
| Pi exits | Pending work is cancelled and the choice is not rewritten |

Automatic restoration never saves. During a `/reload`, Pi Tone holds the current colors in memory until Pi installs its own theme, then sends one terminal-color query through Pi's public API, queued behind Pi's own, before capturing the new Pi theme. It uses no timers or polling. If you select a palette while Pi's reset is still pending, Pi Tone asks you to finish or retry `/reload`; once the reset has happened, your newest command wins over the saved choice.

The choice belongs to the agent directory. Every Pi process and project using it shares the choice, but a process that is already running changes only at its next restoration.

### 2.9 Turn Pi Tone off

Run `/tone-off`, without arguments, when Pi is idle with no queued messages. It cancels pending restoration, removes the canvas, restores your Pi theme if a Tone is shown, deletes `<agent>/pi-tone.json`, and then requests one native `/reload` when needed, so Pi resumes its own theme handling and theme-file watching. A native reload also reloads Pi's other resources. `/tone-off` never deletes palettes, edits Pi settings, or interrupts a response or compaction; running it again does nothing more.

To change the Pi theme underneath your Tones, run `/tone-off`, choose the Pi theme, and select your Tone again.

## 3. Notes and limitations

### 3.1 Scope

Pi Tone sets the 56 TUI color roles of section 2.7. The three HTML-export background options of Pi themes are not supported; HTML export keeps using your Pi theme. Pi Tone never sets terminal default colors or palette entries, and it does not change fonts, transparency, contrast processing, window chrome, the hardware cursor, OS selection colors, shell settings, images, emoji, or colors written by other programs. Terminal transparency, contrast correction, fonts, the hardware cursor, and margins outside the character grid remain the terminal's.

Exact colors need a truecolor terminal without color overrides. In 256-color mode Pi approximates colors, and ANSI indices depend on the terminal's palette. Faint text, fonts, transparency, and contrast adjustments change what you see, so the screen is not guaranteed to contain exactly five colors. There is no automatic contrast correction: check your own foreground and background pairs, including secondary text on selected rows, and rely on Pi's labels and symbols where two states share a color.

Not included: following system dark/light changes, swapping palettes automatically, HTML-export overrides, per-project choices, crash-atomic or cross-process transactions, and cross-platform hardware certification.

### 3.2 How the canvas works

While a palette with `canvas` is active, one adapter wraps Pi's public `TUI.terminal`. It never patches Pi's source, the original Terminal object or its prototype, or global stdout.

- It acts only on Pi's synchronized fullscreen frames. It buffers one frame, finds the rows Pi erases (`CUP(row,1)` followed by `EL(2)`), paints those rows with explicit background-colored spaces before Pi's text and images, and drops only those row erases. It therefore works with and without background-color erase (BCE), and it does not measure text widths, move images, or replace Pi's layout.
- Full redraws (activation, canvas changes, resize, and recovery) paint every row; incremental redraws paint only the rows Pi changes. Style-only SGR codes do not resend colors, and a reset reapplies only the default channel it reset. Explicit role and panel colors keep precedence.
- OSC, DCS, and APC payloads pass through as opaque data, also when split across writes.
- Limits: 16,777,216 UTF-16 code units and 262,144 parts per frame, 128 code units per incomplete CSI sequence, and a grid of at most 8,192 columns or rows and 1,048,576 cells, checked before activation and for every frame. Oversized or unrecognized output passes through unchanged and painting stops.
- Every other Terminal call goes to the original Terminal unchanged and once, including Pi's program-status reports (OSC 7501) and its exit-time terminal restore; Pi keeps their detection and encoding. A method the host lacks is skipped.
- Alternate-screen exit, the transcript Pi replays to the main screen, and Pi's stop and resume transitions pass through unpainted. A forced kill or a broken output stream is not a graceful exit, but the adapter never changes terminal settings that would outlive Pi.
- Switching between canvas palettes reconfigures the same adapter. A palette without `canvas`, `/tone-off`, `/reload`, and exit remove it. Cleanup restores the original Terminal only if Pi still points at the adapter, never overwriting another extension's replacement. Other output decorators, unframed writes, other panes, and terminal margins are outside this contract.

### 3.3 When something fails

Role colors and canvas form one visual change. Pi Tone validates the file and checks fullscreen mode and dimensions first, then replaces the theme, installs the canvas, and requires one complete redraw. Only if all of it succeeds is the name saved. On failure it restores the previous theme and canvas. If the display succeeds but saving fails, the colors stay and a warning says that the choice was not saved.

**Restoring colors is not the same as restoring Pi's theme handling.** Passing a theme object to Pi can pause Pi's theme-file watching and dark/light syncing, even when the colors are restored later. Only a native `/reload` restores that handling.

| Situation | What happens |
|---|---|
| Validation or the canvas check fails before any change | Nothing changes |
| Switching away from a working Tone fails | That Tone and its canvas are restored; its saved choice stays |
| Starting from your Pi theme fails; the rollback succeeds; you typed the command; Pi is idle with nothing queued; reload is available; no choice is saved | One error, then one native `/reload` |
| Any other failure: Pi busy, a saved choice present or unreadable, automatic restoration, another extension took over, or the rollback failed | No forced reload or deletion. The error says that theme handling is not confirmed restored: finish your work, then run `/reload` to retry the saved choice, or `/tone-off` to clear it |
| Canvas output becomes unsupported after activation | Painting stops, your Pi theme's colors are restored, the choice is kept, and one warning asks for `/reload` or `/tone-off` |
| `/tone-off` cannot delete the saved choice | A warning, and no reload, because the Tone would return |
| A native reload fails | Pi reports it; Pi Tone does not claim success |

Pi Tone adds no retry loops, timers, or temporary preference changes. An invalid palette never disables the Tone in use.

### 3.4 Messages

Messages are in English and appear through Pi's native notifications, in the interactive TUI only. In RPC, JSON, and print modes Pi Tone stays silent: it reads no palette or preference, applies and saves nothing, and requests no reload, even for invalid arguments. Pi may still load the extension, list file names, and register commands, and Pi's own loading errors are unaffected.

At startup and `/reload`, file-name problems and a failed saved choice appear together in one notice of at most ten entries, followed by a count of omitted ones. The saved choice comes first, and a problem with the same cause, such as its rejected file name or an unreadable user directory, is reported once. Unresolved problems appear again at the next startup or `/reload`. File-content errors appear when a palette is applied.

A message states the cause first, then the source and the palette name. Each of these fields is shortened separately with `...`, keeping quotes, escapes, and Unicode intact; control and direction characters are shown escaped. Recovery steps are never shortened.

### 3.5 Files, safety, and concurrent processes

- A palette may be at most 256 KiB (262,144 bytes). The preference may be at most 4,096 bytes and must contain exactly one string property, `tone`.
- Files are opened read-only and non-blocking, without following links where the OS allows. Symbolic links, non-regular files, files that change size while being read, and invalid UTF-8 are rejected. The user `pi-tone/` and `themes/` directories must be real directories.
- The preference must be a regular file with one hard link. It is written in place and synchronized with `fsync`; a new file requests mode `0600`, and an agent directory created for it requests `0700`. A failed write tries to restore the previous bytes. There is no temporary file, lock, or crash-atomic guarantee, and existing permissions are not changed.
- Processes sharing an agent directory share the choice, and a later selection in one process can recreate a choice cleared in another.
- `JSON.parse` keeps the last of duplicate keys, so avoid duplicates.
- Pi Tone makes no network requests, collects no telemetry, runs no commands, watches no files, polls nothing in the background, and never executes palette content. These checks do not sandbox Pi or other extensions; review any extension before installing it.

### 3.6 Compatibility and verification

This release is verified against Pi 1.5.0. It uses Pi's public extension, theme, and TUI APIs, and it depends on Pi's lifecycle order, theme color encoding, terminal-query order, and fullscreen frame format. The `"*"` peer ranges avoid bundling a second copy of Pi; they do not promise compatibility with every version. After each Pi release, compatibility is checked again in full, and only the affected parts change.

| Level | Coverage for this release |
|---|---|
| Source | Strict TypeScript check against Pi 1.5.0 types; the built-in palette data checked against sections 2.6 and 2.7 and against Pi's role list |
| Controlled | Real Pi 1.5.0 theme and fullscreen-renderer modules with a simulated extension context: discovery, validation, inheritance, saving, Off, reload restoration, regular-mode rejection, Terminal forwarding, and canvas output emulated with and without BCE |
| Full CLI | The Pi 1.5.0 command-line program in a pseudo-terminal with emulated terminals: applying, saving, `/reload`, `/tone-off`, startup restoration, the colors of all sixteen built-in palettes, regular mode, and program-status pass-through |
| Real terminals | Not performed for this release |

These results do not guarantee behavior in untested terminals, platforms, or future Pi versions. Tests and reports are kept outside the package.
