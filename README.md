<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Hangar Note logo" width="96" height="96">
</p>

<h1 align="center">Hangar Note</h1>

<p align="center"><strong>Your Hangar notes, in their own app and on your desktop.</strong></p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#working-with-hangar">Working with Hangar</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Platform: Windows 10 and 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4">
  <img alt="Built with Tauri 2" src="https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri&logoColor=white">
  <img alt="Status: in development" src="https://img.shields.io/badge/status-in%20development-orange">
  <a href="https://buymeacoffee.com/feoren"><img alt="Buy me a coffee" src="https://img.shields.io/badge/buy%20me%20a%20coffee-support-ffdd00?logo=buymeacoffee&logoColor=black"></a>
</p>

Hangar Note is a desktop notes app for people who use [Hangar](https://github.com/feoren/hangar).
It opens the notes Hangar already keeps per project, in Hangar's own folder and format, with
nothing to import or move. Write in Markdown, sort notes by color, find them with one search, and
put any note on the desktop as a sticky note that stays next to the work in any program.

Hangar Note takes over Hangar's notes area step by step. The desktop app is open source under the
MIT license.

**Status:** in development. There is no release and no installer download yet; you can
[build it from source](#build-from-source). It runs on Windows 10 and 11 today; macOS and Linux
are planned. What is built and what is planned is listed below.

## Features

### Writing

- **Markdown with live styling.** Headings, bold, italic, strikethrough, lists and checklists show
  as you type, and the content stays plain Markdown. A preview shows the rendered note.
- **Checklists that count.** Tick items right in the text; the note shows how many are done.
- **A format bar and shortcuts.** Bold, italic, strikethrough, bulleted list and checklist item, by
  button or by key.
- **Quick notes.** `Ctrl+Shift+N` starts a new note that takes its title from its first line until
  you rename it with `F2`.
- **Saved as you type.** There is no save button. If a save fails, one plain sentence at the
  bottom of the window says what happened and what helps, and the text stays in the editor so you
  can copy it.
- **Line numbers and a status line.** The notes area shows quiet line numbers beside the text. A
  thin status line in the note's color shows line, column, the character count and your selection,
  in the notes area and in every sticky note.

### Finding and sorting

- **Three levels.** _Private_ holds notes that belong to no project, _Project_ the notes of a
  project folder you work on in Hangar, and _Team_ is reserved for team notes (planned, see
  [Planned](#planned)). `Ctrl+1` to `Ctrl+3` switch between them.
- **One search for all notes.** Search your private notes and the notes of every project at once.
- **Eight colors as categories.** Lemon, Peach, Mint, Sky, Lilac, Rose, Sand and Slate. Filter the
  list by one or more colors and give each color a name of your own, such as "Work".
- **Tools on every row.** Color a note, put it on the desktop or delete it right from its row in
  the list, also with a right click, the menu key or `Shift+F10`.
- **A trash that forgives.** Deleting moves a note to the trash. Bring it back with _Undo_ or from
  _Recently deleted_.
- **Take a note with you.** Export a note to a file, copy it as Markdown or show it in the file
  manager.

### Sticky notes

- **Any note on the desktop.** One click puts a note into its own small, frameless window that
  stays visible next to any program. The header in the note's color moves the window.
- **Keep on top.** A sticky note can stay above all other windows.
- **Back where you left it.** Sticky notes reopen at their last position and size when the app
  starts again. A position that is no longer on any screen moves onto the main screen.
- **One editor per note.** While a note sits on the desktop, its sticky note is the only place that
  edits it, so two windows never overwrite each other. _Edit here_ takes it back into the notes
  area.

### Look and comfort

- **Two looks.** _Hangar_ (the default) shows three columns with everything at a glance, like
  Hangar, and switches to a narrow layout in small windows. _Paper_ shows notes as colored slips in
  a grid, with checklists you tick right on them; a note opens as a sheet only when you choose it.
  Sticky notes follow the chosen look.
- **Light or dark.** Follow the system or switch with one click at the bottom of the sidebar.
- **A sidebar that gets out of the way.** Resize it by dragging, fold it away with the round button
  on its edge or with `Ctrl+Shift+S`.
- **In the notification area.** The tray icon offers _All notes_, _New note_ (a new sticky note),
  _Show all notes_ (brings every sticky note to the front) and _Quit_.
- **One instance.** Starting Hangar Note a second time brings the running app to the front.
- **Start with the system**, if you like, and keep the notes area on top.
- **Twelve languages.** English, German, Greek, Spanish, French, Italian, Japanese, Polish,
  Portuguese, Russian, Turkish and Chinese, as in Hangar.
- **Usable by keyboard.** Menus, the level tabs, the sidebar and the look switch work with the
  arrow keys, and _Help > Keyboard shortcuts_ lists the keys that matter.

## Working with Hangar

Hangar Note is built to work next to the Hangar desktop app.

- **Your Hangar notes, in place.** Hangar Note reads and writes Hangar's private notes in Hangar's
  folder and file format. Nothing is migrated, so either app can be updated or removed on its own.
  Colors and sticky note places live in Hangar Note's own files and never in Hangar's, so Hangar
  reads its files as before.
- **Both apps can write at once.** Hangar Note takes a lock around every change of Hangar's index
  files, checks that a note did not change since it was opened before it saves, never creates or
  moves a file over an existing one, and picks up changes made in Hangar within about a second. If
  a note changed in Hangar meanwhile, Hangar Note does not overwrite it and offers to reload or
  copy your text.
- **A command line for Hangar.** It opens a note or a project, starts a quick note or saves text as
  a new note. Hangar will use it to start Hangar Note (see [Command line](#command-line)).
- **A local channel.** A running Hangar Note listens on a token-protected loopback channel, through
  which Hangar will use it (see [Security](#security)).

> Full protection for edits in both apps needs a Hangar release that follows the same rules. Until
> then, avoid editing the same note in Hangar and Hangar Note at the same moment. The details are
> in [ADR 0005](docs/wiki/pages/decisions/0005-shared-notes-folder.md).

## Planned

These parts are decided but not built yet. Follow the progress in
[`docs/wiki`](docs/wiki/index.md).

- **Hangar starts Hangar Note** from its own window, shows "Open in Hangar Note" and routes its
  daily review, capture and launcher search to it.
- **Shared project notes and team notes.** Encrypted notes that travel with the repository, for one
  person with a recovery code or for a whole team through Hangar. Hangar keeps the team keys;
  Hangar Note asks Hangar to open and seal each team note and never holds the key ring itself.
- **macOS 13 or later** (Apple silicon and Intel) and **Linux x64** (X11 and Wayland).
- **Releases** with installers and signed updates.

Not planned: sync between devices beyond Git and the Hangar relay, images and reminders.

## Getting started

### Install

There is no release yet. Until the first one, [build Hangar Note from source](#build-from-source);
installers for download will follow on the GitHub releases page.

### First steps

1. **Open the notes area.** Start Hangar Note. If Hangar keeps notes on this computer, they are
   there at once.
2. **Write.** Press `Ctrl+Shift+N` for a quick note and start typing; it saves as you type.
3. **Sort.** Give the note a color from its row and filter the list by color in the sidebar.
4. **Put it on the desktop.** Choose _To the desktop_ on the note. It opens as a sticky note and
   comes back after a restart.

### Keyboard shortcuts

On macOS (planned) `Cmd` takes the place of `Ctrl`. No shortcut takes a `Ctrl+letter` that the
editor needs for typing.

- `Ctrl+Shift+N` in the notes area: quick note, titled by its first line
- `Ctrl+N` in a sticky note: a new sticky note
- `F2`: rename the open note, or a color in the sidebar
- `Delete` on a note in the list: move it to the trash
- `Shift+F10` or the menu key: open the menu of a note or a color
- `Ctrl+1` to `Ctrl+3`: show the level Private, Project or Team
- `Ctrl+Shift+S`: show or hide the sidebar
- `Ctrl+B`, `Ctrl+I`, `Ctrl+Shift+X`: bold, italic, strikethrough
- `Ctrl+Shift+8`, `Ctrl+Shift+9`: bulleted list, checklist item
- `Escape` in a sticky note: leave the editor and hide the format bar

Letter shortcuts follow the letter your keyboard layout types, so `Ctrl+B` is bold on Dvorak too.
`AltGr` never triggers a shortcut.

### Command line

These are the commands Hangar will use to start Hangar Note, and you can use them today. A command
sent while Hangar Note runs goes to the running app.

```text
hangar-note                                         open the notes area
hangar-note open [--folder <path>] [--note <id>]    open a project's notes or one note
hangar-note quick [--folder <path>]                 start a quick note
hangar-note capture --folder <path>                 save the text from stdin as a new note
```

- `--folder` takes an absolute path.
- `capture` reads at most 1 MiB of UTF-8 text from stdin, saves it as a new note in that project
  with the time and the folder name, and shows it.
- `open` also accepts `--shared`; until shared notes exist, the private notes open.

`capture` exits with `0` only after the app confirmed that it saved the text. Other exit codes:
`1` failed, `2` wrong command line or input, `3` the notes are read only, `4` Hangar Note runs but
did not confirm that it took the text. With no app running, `capture` starts Hangar Note itself
and keeps the text.

## Where your notes live

- **Notes:** in Hangar's notes folder, one Markdown file per note plus an index per project, on
  Windows under `%LOCALAPPDATA%\com.feoren.hangar\notes`. The format is described in
  [hangar-notes-format](docs/wiki/pages/concepts/hangar-notes-format.md).
- **Hangar Note's own data:** colors, color names, sticky note places and settings, on Windows
  under `%LOCALAPPDATA%\com.feoren.hangar-note`.

If another Hangar Note already writes the notes, or the folder cannot be locked, the notes open
read only and the app says so.

## Requirements

- **Operating system:** Windows 10 version 1809 or later, or Windows 11 (x64). macOS 13 or later
  and Linux x64 are planned.
- **WebView2:** part of Windows 11. On Windows 10, install the Microsoft Edge WebView2 Runtime if
  it is missing.
- **Hangar:** recommended. Hangar Note uses Hangar's notes folder, and the project level and the
  command line are made for Hangar.

## Build from source

You need [Git](https://git-scm.com), [Rust](https://rustup.rs) (stable, 1.90 or later),
[Node.js](https://nodejs.org) 22.13 or later on an LTS line (22, 24 or 26),
[pnpm](https://pnpm.io) 12 (the exact version is pinned in `package.json`) and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform (on Windows
the Microsoft C++ Build Tools and WebView2).

```sh
git clone https://github.com/feoren/hangar-note.git
cd hangar-note
pnpm install

# Run in development mode with hot reload
pnpm tauri dev

# Build your own installer
pnpm tauri build
```

On Windows the installer lands in `src-tauri/target/release/bundle/nsis/` and installs for your
user only.

**Keep your real notes out of development.** A debug build uses Hangar's real notes folder unless
the environment variable `HANGAR_NOTE_NOTES_ROOT` points it at another folder with Hangar's
layout. The value must be an absolute path on this computer: a relative path, a network share or a
device path is refused, and a folder inside Hangar's real notes folder is ignored, so the real
notes are used then. Release builds ignore the variable.

```sh
# Bash, zsh
HANGAR_NOTE_NOTES_ROOT=/absolute/path/to/test-notes pnpm tauri dev
```

```powershell
# PowerShell
$env:HANGAR_NOTE_NOTES_ROOT = "C:\absolute\path\to\test-notes"; pnpm tauri dev
```

**Check suite.** Everything must pass before a pull request is merged:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm format:check && pnpm lint && pnpm test && pnpm build
```

## Architecture

Hangar Note is a [Tauri 2](https://v2.tauri.app) app. The Rust backend owns every window, file,
the tray icon and the local channel; the React frontend only renders and calls the backend
commands its window is allowed to use.

- **Backend** (`src-tauri/src/`): Hangar's notes store (`notes.rs`), access and locking
  (`access.rs`), the notes service (`service.rs`), colors and sticky places (`meta.rs`), capture
  (`capture.rs`), the command line (`cli.rs`), the local channel (`channel/`), the watcher for
  outside changes (`watch.rs`), windows, tray and settings.
- **Frontend** (`src/`): React 19, TypeScript in strict mode and Vite. One notes area
  (`useNotesArea.tsx`) with a layout per look (`HangarLayout.tsx`, `HangarNarrowLayout.tsx`,
  `PaperLayout.tsx`), the sticky note (`NoteWindow.tsx`), the CodeMirror 6 editor (`editor.ts`),
  all shortcuts in one module (`shortcuts.ts`) and all texts in one i18n module (`i18n.ts`).
- **Decisions** are recorded as ADRs in [`docs/wiki`](docs/wiki/index.md):
  [0001 Foundation](docs/wiki/pages/decisions/0001-foundation.md),
  [0002 Taking over Hangar's notes](docs/wiki/pages/decisions/0002-hangar-notes-takeover.md),
  [0003 Version scheme](docs/wiki/pages/decisions/0003-version-scheme.md),
  [0004 Switchable looks](docs/wiki/pages/decisions/0004-switchable-looks.md) and
  [0005 Sharing the notes folder with Hangar](docs/wiki/pages/decisions/0005-shared-notes-folder.md).

**Versions** read `X.Y.Z-B`: major, minor, revision and build number, as in Hangar. The build
number is the commit count of the built state. The upcoming version and its changes are in
[`src/changelog.json`](src/changelog.json).

## Security

- **Least privilege for the window.** Each window may call only the backend commands granted to it.
  File access, save dialogs and the clipboard stay in the backend.
- **A strict Content Security Policy.** Scripts and styles come only from the app itself, with no
  inline scripts and no `eval`; frames, workers and remote connections are blocked. The windows
  can only navigate to the app's own pages.
- **A guarded local channel.** It listens on `127.0.0.1` only, on a random port, with a 32-byte
  token that changes on every start. The file that holds the token is readable by your user only.
  The app proves itself to a client before any content flows, and browser requests are refused.
- **No notes in logs.** A note's text never reaches a log. Storage errors are logged with the kind
  of file and the error number only, and the window shows a fixed error code as a plain sentence.
- **Checked dependencies.** [`src-tauri/deny.toml`](src-tauri/deny.toml) keeps the license
  allowlist for every crate of the build and checks the RustSec advisories with `cargo deny`.

The channel and its checks are described in
[local-channel](docs/wiki/pages/syntheses/local-channel.md). Please report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains the
check suite and the guidelines, and everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md). Questions are welcome in the
[discussions](https://github.com/feoren/hangar-note/discussions).

Related projects: [Hangar](https://github.com/feoren/hangar), the desktop app for running AI coding
agents as a team, and [Hangar Server](https://github.com/feoren/hangar-server), the self-hosted
server for Hangar teams.

## Support

Hangar Note is made in spare time, without investors, ads or tracking. If it saves you time, you
can [buy me a coffee](https://buymeacoffee.com/feoren). Thank you!

## License

Hangar Note is licensed under the [MIT License](LICENSE).
