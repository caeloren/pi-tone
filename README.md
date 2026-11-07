# Pi Tone

## 1. Introduction

Pi Tone recolors Pi's interactive terminal UI. Run `/tone-<name>` to apply a palette: only the color roles it sets change, every other role keeps your Pi theme's color, and palettes never stack. A palette can also paint Pi's fullscreen background and default text with a canvas.

Sixteen palettes are built in, and you can add your own as JSON files. Your selection is restored after a restart or `/reload`; `/tone-off` clears it and hands theme handling back to Pi. Without a saved selection, Pi Tone changes nothing.

Pi Tone does not change your terminal's settings, Pi's settings, or Pi's theme files. The only file it writes is your saved selection.

Pi Tone 1.0.0 is verified with Pi 1.5.0; other Pi versions may need an update. Author: `caeloren`. License: [Sustainable Use License 1.0](LICENSE) (`SUL-1.0`).

## 2. Usage

### 2.1 Install, update, and remove

Run these commands in a shell:

```bash
pi install git:github.com/caeloren/pi-tone
pi update git:github.com/caeloren/pi-tone
pi remove git:github.com/caeloren/pi-tone
```

- After updating Pi Tone, run `/reload` in any Pi session that is already running. After updating Pi itself, restart Pi.
- Pi keeps Pi Tone in its own folder, `<agent>/git/github.com/caeloren/pi-tone` (or `.pi/git/github.com/caeloren/pi-tone` in the project with `-l`), and an update can delete every file there that is not part of Pi Tone. Keep nothing of yours in that folder: your palettes belong in `<agent>/pi-tone/themes/` (section 2.3). Move any you have kept there before you update.
- To stay on this release, install `git:github.com/caeloren/pi-tone@v1.0.0` instead. `pi update` does not move a pinned release; to change it, install another release tag the same way, or the address without `@v1.0.0` to follow the latest version. `pi remove git:github.com/caeloren/pi-tone` removes either form.
- Before removing Pi Tone, run `/tone-off` in Pi. If you skip it, your saved selection stays in `<agent>/pi-tone.json` (section 2.3) and returns if you reinstall; you can delete that file yourself. Removing never deletes your palettes; delete `<agent>/pi-tone/` if you no longer need them.
- For a project install, add `-l` (`--local`) to `install` and `remove`. Pi loads project packages only after you trust the project, and the saved selection is still shared by all projects.
- To install from a downloaded copy of this repository, run `pi install /absolute/path/to/pi-tone`, and remove it with `pi remove` and the same path. Pi loads Pi Tone from that folder, so keep it; to update, replace its files and run `/reload`. The copy's folder must not contain your palette folder or be inside it, so do not use `<agent>/pi-tone/`; otherwise Pi Tone shows an error and no palette can be used.

### 2.2 Commands and file names

A palette's command is `/tone-` followed by its file name without `.json`. Run commands in Pi's input editor.

| Palette | Command |
|---|---|
| Built-in `dark` | `/tone-dark` |
| `soft.json` | `/tone-soft` |
| `soft gray.json` | `/tone-soft gray` |
| `柔和 色.json` | `/tone-柔和 色` |

- Type `/tone-` to see the palettes; completion suggests matching names. Names must match exactly, including case and spaces, so `soft gray` and `soft  gray` (two spaces) are different palettes.
- Pi's suggestion list ignores letter case, and Enter runs the highlighted suggestion. When two names differ only in case, such as your `Dark.json` and the built-in `dark`, choose with the arrow keys, or press Esc to close the list and then press Enter.
- `/tone-off` is the only other command.
- Pi Tone reads a palette when you apply it, so after editing one, run its command again. After adding a palette with a new name, or renaming or deleting one, run `/reload` to update the commands; a renamed file also needs a matching `name`. Adding or deleting your own copy of a built-in palette takes effect the next time you run its command.

Your palettes must be regular files whose names end in lowercase `.json`. At startup and `/reload`, Pi Tone skips these and shows an error that asks you to rename or replace them:

- `off.json` and names that start with `off ` (such as `off gray.json`), in any letter case (such as `Off.json` or `OFF gray.json`), which belong to `/tone-off`; names such as `off-blue.json` and `off_gray.json` are fine
- names containing `@`, which Pi reserves for file references
- names with a leading period or another period, such as `.soft.json` or `theme.v2.json`
- names with whitespace, or the invisible U+FEFF, just before `.json`, such as `soft .json`, and names with no visible characters
- names with path separators, control characters, line or paragraph separators, or Unicode bidirectional formatting characters, and names that are not valid UTF-8
- folders and links named `*.json`; these also hide the built-in palette of the same name

Files with other extensions, such as `dark.JSON` or `notes.txt`, are ignored.

### 2.3 Where files live

| Location | Contents |
|---|---|
| `<agent>/pi-tone/themes/` | Your palettes |
| `<agent>/pi-tone.json` | Your saved selection |

`<agent>` is Pi's agent folder: `~/.pi/agent`, or the folder in `PI_CODING_AGENT_DIR` when it is set.

- Pi Tone palettes are not Pi theme files. Keep them in `<agent>/pi-tone/themes/`, not in Pi's `<agent>/themes/`.
- A palette of yours with the same name as a built-in palette replaces it completely. The two are never merged, and if your file is invalid or unreadable, Pi Tone reports it instead of using the built-in palette.
- `<agent>/pi-tone/` and `<agent>/pi-tone/themes/` must be real folders, not links. If either is a link, is not a folder, or cannot be read, every palette command, including the built-in ones, stops working until you fix it and run `/reload`. `/tone-off` keeps working.

Pi Tone never creates, edits, or deletes files in your palette folder; without the folder, only the built-in palettes are available. Create it yourself:

```bash
mkdir -p "$HOME/.pi/agent/pi-tone/themes"
```

```powershell
New-Item -ItemType Directory -Force -Path (Join-Path $HOME ".pi/agent/pi-tone/themes")
```

With `PI_CODING_AGENT_DIR` set, create `pi-tone/themes` inside that folder instead.

### 2.4 Write a palette

A palette is a UTF-8 JSON file. For example, `<agent>/pi-tone/themes/soft headings.json`:

```json
{
  "name": "soft headings",
  "vars": { "heading": "#D8D8D8" },
  "colors": { "mdHeading": "heading", "mdLink": "heading" }
}
```

Run `/reload`, then `/tone-soft headings`.

| Property | Meaning |
|---|---|
| `name` | Required. The file name without `.json`, exactly |
| `colors` | Optional. The roles to change (section 2.7) |
| `vars` | Optional. Named values for this file; a variable may refer to another variable |
| `canvas` | Optional fullscreen canvas (section 2.5) |
| `appearance` | Optional `"dark"` or `"light"`: the kind of background the palette is designed for. If omitted, your Pi theme's value is kept |
| `$schema` | Optional string; Pi Tone ignores its value |

| Color value | Example |
|---|---|
| Hex, 3 or 6 digits | `"#abc"`, `"#AABBCC"` |
| OKLCH | `"oklch(62% 0.1 200)"` |
| OKHSL | `"okhsl(250 60% 55%)"` |
| ANSI palette index, 0 to 255 | `39` |
| Variable name | `"heading"` |
| Terminal default color | `""` |

- Any other text is read as a variable name, so `"red"` works only if `vars` defines `red`.
- Pi Tone rejects the whole file, before anything changes, if it has an unknown property or role, an invalid value, or a variable that is undefined, circular, or invalid, even if unused. Comments and trailing commas are not allowed, and if a key is repeated, the last value wins.
- A role you leave out keeps your Pi theme's color. `""` uses the terminal's default color, which a canvas can repaint.
- A palette with no colors and no canvas shows your Pi theme's colors and is still saved as your selection; it does not turn Pi Tone off.

### 2.5 Fullscreen canvas

Without a canvas, Pi Tone changes only role colors; text and backgrounds drawn in the terminal's default colors stay as they are. A canvas paints them:

```json
"canvas": { "background": "G0", "foreground": "G4" }
```

- `background` is required and `foreground` is optional. Both take the color values of section 2.4 except `""`.
- A palette without `canvas` has none: it does not keep the previous palette's canvas or take the canvas of a built-in palette it replaces. All built-in palettes have one.
- A canvas needs Pi's fullscreen mode. Fullscreen is the default and is chosen with the `tuiMode` setting or the `--tui-mode` option. In regular mode, a palette with a canvas is rejected before anything changes; palettes without a canvas work in both modes.
- If you switch Pi to regular mode in `/settings` while a palette with a canvas is active, Pi Tone stops the canvas, restores your Pi theme's colors, and keeps your selection. Switch back to fullscreen and run the palette's command to use it again.
- To use a built-in palette in regular mode, copy the example in section 2.6, set `appearance` to `"dark"` or `"light"` as the palette's name says, set the five variables from that palette's row, and remove `canvas`. Without a canvas your terminal's background stays, so use a dark palette on a dark terminal and a light palette on a light one.

| In fullscreen | Shown as |
|---|---|
| Default background, including BG roles set to `""` | `canvas.background` |
| Default foreground, including FG roles set to `""` | `canvas.foreground`, or the terminal default if it is not set |
| Explicit role colors and panel backgrounds | Unchanged |

The canvas changes only what Pi draws, not the terminal's own colors. Margins outside the terminal's character grid are not painted, and neither is the transcript Pi prints when it exits or is suspended: it keeps the palette's text colors on your terminal's own background, so it can be hard to read when the palette does not suit that background.

### 2.6 Built-in palettes

Each built-in palette has five shades of one hue, or of gray for `dark` and `light`:

| Palette | G0 | G1 | G2 | G3 | G4 |
|---|---|---|---|---|---|
| `dark` | `#101010` | `#1C1C1C` | `#727272` | `#A6A6A6` | `#FAFAFA` |
| `light` | `#FAFAFA` | `#E8E8E8` | `#7D7D7D` | `#4F4F4F` | `#101010` |
| `red-dark` | `#1E1312` | `#332120` | `#B6918D` | `#DABCB9` | `#FBEAE8` |
| `red-light` | `#FFF2F0` | `#F0D8D6` | `#7B5956` | `#5A3E3B` | `#291918` |
| `orange-dark` | `#1C140D` | `#302418` | `#AF967F` | `#D5C0AD` | `#F7ECE2` |
| `orange-light` | `#FCF3EC` | `#EADACC` | `#755E48` | `#56422F` | `#261C11` |
| `yellow-dark` | `#18160D` | `#292717` | `#A19C7D` | `#C9C5AC` | `#F1EFE2` |
| `yellow-light` | `#F7F6EB` | `#E2DFCC` | `#696446` | `#4B472E` | `#211E10` |
| `green-dark` | `#101812` | `#1D2A1F` | `#88A48D` | `#B5CBB8` | `#E6F2E8` |
| `green-light` | `#EFF8F0` | `#D2E3D5` | `#516B56` | `#374D3B` | `#162118` |
| `blue-dark` | `#0F171D` | `#1A2832` | `#83A0B5` | `#B1C8D9` | `#E4F0FA` |
| `blue-light` | `#EDF7FE` | `#D0E1EF` | `#4C677B` | `#32495A` | `#132029` |
| `indigo-dark` | `#14151E` | `#222534` | `#939AB8` | `#BDC3DB` | `#EBEEFB` |
| `indigo-light` | `#F2F5FF` | `#D9DEF1` | `#5B627D` | `#40455C` | `#1A1D2A` |
| `purple-dark` | `#19141C` | `#2A2330` | `#A494B1` | `#CBBED6` | `#F2EBF8` |
| `purple-light` | `#F8F3FC` | `#E4DAEC` | `#6B5C77` | `#4D4057` | `#221B27` |

| Shade | Used for |
|---|---|
| `G0` | Canvas background and search-match background |
| `G1` | Message, tool, and selection backgrounds |
| `G2` | Code comments, removed diff lines, and ordinary and muted borders |
| `G3` | Secondary text, code strings and numbers, and `accent` |
| `G4` | Main text, emphasized borders, and canvas foreground |

All sixteen palettes use the same role-to-shade mapping, shown in the example below, and a canvas of `G0` background and `G4` foreground.

To start your own palette from a built-in one, save the following as `<agent>/pi-tone/themes/example.json`, run `/reload`, and then run `/tone-example`. It equals `blue-dark` except for its name; change the five variables to recolor it.

```json
{
  "name": "example",
  "appearance": "dark",
  "vars": { "G0": "#0F171D", "G1": "#1A2832", "G2": "#83A0B5", "G3": "#B1C8D9", "G4": "#E4F0FA" },
  "colors": {
    "searchMatchBg": "G0",
    "selectedBg": "G1", "userMessageBg": "G1", "customMessageBg": "G1",
    "toolPendingBg": "G1", "toolSuccessBg": "G1", "toolErrorBg": "G1",
    "border": "G2", "borderMuted": "G2", "scrollbarTrack": "G2", "mdQuoteBorder": "G2", "mdHr": "G2",
    "toolDiffRemoved": "G2", "syntaxComment": "G2",
    "accent": "G3", "success": "G3", "muted": "G3", "dim": "G3", "thinkingText": "G3",
    "customMessageText": "G3", "toolOutput": "G3", "mdLinkUrl": "G3", "mdCodeBlockBorder": "G3",
    "mdQuote": "G3", "toolDiffContext": "G3", "syntaxString": "G3", "syntaxNumber": "G3",
    "syntaxOperator": "G3", "syntaxPunctuation": "G3",
    "thinkingOff": "G3", "thinkingMinimal": "G3", "thinkingLow": "G3",
    "borderAccent": "G4", "error": "G4", "warning": "G4", "text": "G4", "scrollbarThumb": "G4",
    "searchMatchText": "G4", "userMessageText": "G4", "customMessageLabel": "G4", "toolTitle": "G4",
    "mdHeading": "G4", "mdLink": "G4", "mdCode": "G4", "mdCodeBlock": "G4", "mdListBullet": "G4",
    "toolDiffAdded": "G4", "syntaxKeyword": "G4", "syntaxFunction": "G4", "syntaxVariable": "G4",
    "syntaxType": "G4", "thinkingMedium": "G4", "thinkingHigh": "G4", "thinkingXhigh": "G4",
    "thinkingMax": "G4", "bashMode": "G4"
  },
  "canvas": { "background": "G0", "foreground": "G4" }
}
```

Saved as `blue-dark.json` with `"name": "blue-dark"`, it replaces the built-in `blue-dark`; delete the file to use the built-in palette again.

### 2.7 Color roles

Pi 1.5.0 has 56 TUI color roles. FG roles color text and BG roles color backgrounds; section 2.6 shows the shade each role uses in the built-in palettes.

#### General interface

| Role | Slot | Colors |
|---|---|---|
| `accent` | FG | Primary accent, such as the selected item in a list |
| `border` | FG | Ordinary borders |
| `borderAccent` | FG | Emphasized borders |
| `borderMuted` | FG | Low-emphasis borders |
| `success` | FG | Success states |
| `error` | FG | Error states |
| `warning` | FG | Warning states |
| `muted` | FG | Secondary text |
| `dim` | FG | Low-emphasis text |
| `text` | FG | Body text |
| `thinkingText` | FG | Thinking text |

#### Selection, search, and scrollbar

| Role | Slot | Colors |
|---|---|---|
| `selectedBg` | BG | Selected item |
| `scrollbarTrack` | FG | Fullscreen scrollbar track |
| `scrollbarThumb` | FG | Fullscreen scrollbar thumb |
| `searchMatchBg` | BG | Transcript search matches; the current match is shown inverted |
| `searchMatchText` | FG | Text of transcript search matches |

#### Messages and tools

| Role | Slot | Colors |
|---|---|---|
| `userMessageBg` | BG | Your message panel |
| `userMessageText` | FG | Your message text |
| `customMessageBg` | BG | Panels for extension messages, compaction and branch summaries, and skill invocations |
| `customMessageText` | FG | Text in those panels |
| `customMessageLabel` | FG | Labels in those panels |
| `toolPendingBg` | BG | Pending or running tool panel |
| `toolSuccessBg` | BG | Successful tool panel |
| `toolErrorBg` | BG | Failed tool panel |
| `toolTitle` | FG | Tool name |
| `toolOutput` | FG | Tool output |

#### Markdown

| Role | Slot | Colors |
|---|---|---|
| `mdHeading` | FG | Headings |
| `mdLink` | FG | Link text |
| `mdLinkUrl` | FG | Link URLs |
| `mdCode` | FG | Inline code |
| `mdCodeBlock` | FG | Code-block text without syntax highlighting |
| `mdCodeBlockBorder` | FG | Code-block fences |
| `mdQuote` | FG | Quote text |
| `mdQuoteBorder` | FG | Quote border |
| `mdHr` | FG | Horizontal rules |
| `mdListBullet` | FG | List bullets and numbers |

#### Diffs

| Role | Slot | Colors |
|---|---|---|
| `toolDiffAdded` | FG | Added lines, marked `+` |
| `toolDiffRemoved` | FG | Removed lines, marked `-` |
| `toolDiffContext` | FG | Unchanged lines |

#### Syntax highlighting

| Role | Slot | Colors |
|---|---|---|
| `syntaxComment` | FG | Comments |
| `syntaxKeyword` | FG | Keywords |
| `syntaxFunction` | FG | Function names |
| `syntaxVariable` | FG | Variable names |
| `syntaxString` | FG | Strings and regular expressions |
| `syntaxNumber` | FG | Numbers and literals such as `true` and `null` |
| `syntaxType` | FG | Type names |
| `syntaxOperator` | FG | Operators |
| `syntaxPunctuation` | FG | Punctuation |

Pi colors only the parts of code its highlighter marks. Most languages leave operators and punctuation unmarked, so they appear in the default foreground color.

#### Thinking levels and Bash mode

| Role | Slot | Colors |
|---|---|---|
| `thinkingOff` | FG | Editor border and indicator, thinking off |
| `thinkingMinimal` | FG | Editor border and indicator, minimal thinking |
| `thinkingLow` | FG | Editor border and indicator, low thinking |
| `thinkingMedium` | FG | Editor border and indicator, medium thinking |
| `thinkingHigh` | FG | Editor border and indicator, high thinking |
| `thinkingXhigh` | FG | Editor border and indicator, xhigh thinking |
| `thinkingMax` | FG | Editor border and indicator, max thinking |
| `bashMode` | FG | Editor border in Bash mode; borders, spinner, and command line of `!` command output |

### 2.8 Saved selection

When a palette applies successfully, Pi Tone saves only its name to `<agent>/pi-tone.json`:

```json
{ "tone": "blue-dark" }
```

- The saved palette is applied again at startup, after `/reload`, and when you start, resume, or fork a session. Its file is read again each time.
- If the saved palette is missing, invalid, or cannot be shown (for example, it has a canvas and Pi runs in regular mode), Pi Tone shows an error and keeps Pi's colors. The selection stays saved, so the error returns until you fix the cause and run `/reload`, choose another palette, or run `/tone-off`.
- Pi processes that use the same agent folder share the selection. The latest selection wins; other running processes use it after their next `/reload` or new session.

### 2.9 Turn Pi Tone off

Run `/tone-off`, without arguments, while Pi is idle and has no queued messages; if Pi is still working, a warning asks you to run it again later. It removes the canvas, restores your Pi theme's colors, deletes the saved selection, and then, if Pi Tone has paused Pi's theme handling, runs `/reload` so that Pi takes it back; this also reloads Pi's other resources. It never deletes palettes or changes Pi's settings, and once it has finished, running it again does nothing more.

To change the Pi theme under your palette, run `/tone-off`, choose the Pi theme in `/settings`, and then run your palette's command again. Browsing the theme list in `/settings` while a palette is active replaces the palette, even if you press Esc; run its command again to bring it back.

## 3. Notes and limitations

### 3.1 Scope

- Pi Tone changes only Pi's TUI: its 56 color roles and, with a canvas, the default colors in fullscreen. HTML export keeps your Pi theme's colors.
- It does not change terminal colors, fonts, transparency, the cursor, the terminal's text-selection colors, images, or colors printed by other programs.
- It works only in Pi's interactive TUI. In RPC, JSON, and print modes, it shows no messages and does not read, apply, or save palettes or your selection.
- While a palette is active, Pi's theme handling is paused: Pi does not reload edited Pi theme files or follow your terminal's dark or light changes. `/tone-off` brings it back.
- Another extension that changes Pi's theme replaces the palette, as browsing themes in `/settings` does. If it does so while a session starts, your saved palette may not be restored; run the palette's command again.
- Exact colors need truecolor output. If your terminal supports truecolor but Pi uses 256 colors, as can happen inside tmux, set `PI_TRUE_COLOR=1`, or set `terminal.trueColor` to `true` in Pi's settings. Terminal apps and their settings, such as transparency, minimum contrast, and how faint text is drawn, also change what you see; Pi Tone is not certified for every terminal app and platform.
- There is no automatic contrast adjustment. In the built-in palettes, pending, successful, and failed tool panels share one background, errors and warnings share one color, and the thinking levels use two border colors; rely on Pi's labels and symbols to tell them apart. Transcript search matches other than the current one have the canvas background, so on it only Pi's underline marks them.
- Not supported: switching palettes automatically, such as with the system's dark or light mode, and per-project selections.

### 3.2 When something fails

- Pi Tone checks a palette completely before changing anything, and saves the selection only after its colors and canvas are both shown. If applying fails, the previous look is restored, and an invalid palette file never turns off the palette in use.
- If a palette fails after it has replaced your Pi theme, Pi's theme handling stays paused. Pi Tone then runs `/reload` itself when it safely can; otherwise the message says what gives the handling back: `/reload` or `/tone-off` when no selection is saved; `/tone-off` when one is saved, since `/reload` tries the saved palette again; and `/reload` when the saved selection cannot be read.
- If the palette is shown but cannot be saved, an error says so; the palette stays for the current session.
- If the canvas cannot keep drawing safely, for example because Pi writes output the canvas does not recognize or another extension takes over Pi's terminal output, Pi Tone stops the canvas, restores your Pi theme's colors, keeps your selection, and shows an error that says how to try again.
- If `/tone-off` cannot delete the saved selection, it shows an error and does not reload.
- If a palette command says that Pi has not finished reloading its theme, Pi's last reload stopped before Pi applied its theme, usually with a "Reload failed" error from Pi. Fix what Pi reported and run `/reload`. Until a reload finishes, palettes cannot be applied, and `/tone-off` can clear your selection but cannot bring back Pi's own theme.

### 3.3 Messages and safety

- Messages are in English and use Pi's own notifications: an error when something failed or cannot be used, a warning when you only need to wait or correct a command, and a plain message for success. Each says what happened and, when something needs your action, what to do.
- Problems found at startup or `/reload`, such as skipped files, are listed together in one error, ten at most, followed by the number of the rest. A problem with your saved palette is reported once, together with the file or folder problem that causes it.
- Control characters in file names and paths are shown as escapes such as `\u001b`.
- A palette file may be at most 256 KiB.
- Pi Tone makes no network requests, collects no telemetry, runs no external programs, watches no files, and never executes palette content.


https://github.com/user-attachments/assets/7a699b9d-1a9a-4b9b-bee7-e73ff9cfcf29
