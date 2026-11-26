---
title: "ADR 0001: Foundation: sticky notes on the desktop"
type: decision
status: accepted
superseded_by:
tags: [foundation, scope, tauri, notes, windows, storage]
sources: []
created: 2026-11-25
updated: 2026-11-26
---

# ADR 0001: Foundation: sticky notes on the desktop

## Context
The owner wants Hangar Note to be a notes tool in the style of Windows Sticky Notes: small colored
notes that sit on the desktop as their own windows, written in Rust like Hangar, as a client program
of the Hangar family.

Hangar itself already keeps notes, but inside its own window: a notes panel per working folder,
stored as `.md` files in Hangar's app data folder (Hangar ADR 0004), plus encrypted project notes in
the repository (Hangar ADR 0006). What it lacks is a note that stays visible on the desktop while
any program is in front. That is the gap Hangar Note fills.

Hangar's stack and conventions are the starting point: Tauri 2, React, TypeScript strict, Vite,
pnpm, CodeMirror 6 for Markdown editing, 12 UI languages, the design tokens of Hangar's
`src/styles.css`, versions X.Y.Z-Build.

## Options

### Window model
1. **One window per note** (like Windows Sticky Notes), plus a small "All notes" window to find,
   open and create notes. Notes stay on the desktop next to any program.
2. **One window with tabs or a list** (like Hangar's notes panel or Notepad). Simpler, but it is the
   notes panel Hangar already has; it does not put a note next to the work.
3. **A single overlay window** that draws all notes on a transparent full-screen surface. Avoids
   many windows, but transparent click-through windows behave differently per platform and
   compositor, and every click on the desktop would need hit testing. Rejected.

### Storage
1. **One Markdown file per note plus an index file** in the app data folder. Readable in the file
   manager, same format as Hangar's notes, a broken index can be rebuilt from the files.
2. **SQLite.** Robust queries, but notes become invisible outside the app, and the data set
   (dozens to hundreds of short notes) needs no database. Rejected.
3. **localStorage in the WebView.** Lost when WebView data is cleared, no backend checks. Rejected
   (same reasons as Hangar ADR 0004).

### Editor
1. **CodeMirror 6 with Markdown and live styling** (bold shows bold, checkboxes are clickable).
   Already used and understood in Hangar; content stays plain Markdown.
2. **A rich text editor (ProseMirror, Lexical).** Closer to Sticky Notes' look, but the content
   would be a document model, not Markdown, and it is a new large dependency. Rejected for now.
3. **A plain textarea.** No formatting at all. Rejected.

### Relation to Hangar's notes
1. **Own storage, no access to Hangar's data.** Hangar Note never reads or writes Hangar's app
   data folder. Integration comes later through an explicit interface.
2. **Show Hangar's notes as sticky notes.** Attractive, but two programs writing the same files
   without a contract risks lost edits. Deferred until both sides agree on a contract.

## Decision
Window model option 1, storage option 1, editor option 1, Hangar relation option 1.

### Windows
- **Note window** (label `note-<id>`): frameless (`decorations: false`), resizable, default
  320 x 320 logical px, minimum 200 x 160. Header row as the drag region with: "New note" (+),
  a menu (color, "Keep on top", "Delete note", "All notes") and "Close". Closing hides the note
  (it stays in the list and keeps its content); only "Delete note" removes it.
  Below the editor a slim formatting bar, shown while the focus is anywhere in the note window
  (so it can be reached with Tab): bold, italic, strikethrough, bullet list, checklist item.
- **"All notes" window** (label `hub`): search field, "New note", the notes as cards (color, first
  lines, last change), click opens or brings the note to the front, a context menu with "Delete".
  A small settings area: language, theme (system, light, dark), start with the system, color of
  new notes.
- **Changed on 2026-11-26 (direction A, see [[usability-pass]]):** the sticky note shows only its
  text at rest; a 10 px color strip at the top is always its drag region, and the header and the
  formatting bar fade in on hover or focus in places kept free for them. The "All notes" window is
  the notes area of [[0002-hangar-notes-takeover]]: a title menu with the scopes and the former list
  menu, a list whose rows show the color as a thin edge and carry tools and a context menu, the
  open note as a page, and one notice place in the footer (`src/notices.ts`, `src/errors.ts`).
- **Tray icon:** "All notes", "New note", "Show all notes", "Quit". Closing the "All notes" window
  hides it; "Quit" ends the app. Without a working tray (some Linux desktops), closing the last
  window quits.
- **One instance per user session** (`tauri-plugin-single-instance`); a second start opens
  "All notes".
- **On startup** every note that was open reopens at its last position and size. A position that
  is no longer on any monitor is moved onto the primary monitor (pure function, tested).
- The backend creates and owns all windows; the frontend asks for them through commands.

### Storage
> [!warning] Replaced
> Since phase 1 of [[0002-hangar-notes-takeover]] the notes live in Hangar's folder and format
> ([[hangar-notes-format]]); colors and sticky places are in `meta.json`. The files of this section
> are no longer read and are left where they are.

Under `app_local_data_dir()/notes/` (Windows `%LOCALAPPDATA%\<identifier>\notes`):
- `<id>.md`: the content as Markdown, UTF-8, at most 1 MiB. `id` is a UUID v4, so file names never
  depend on user text.
- `notes.json`: `{ version: 1, notes: [{ id, color, bounds: { x, y, width, height } | null, open,
  onTop, createdAt, updatedAt }] }`, times in Unix ms, bounds in logical px.
- Every write is atomic (temporary file in the same folder, then rename).
- A corrupt `notes.json` is set aside (`notes.json.broken-<millis>`) and rebuilt from the `.md`
  files with default values; an `.md` file without an entry is adopted, an entry without a file
  is dropped.
- **Delete** moves the file to `.trash/` and records `{ id, color, deletedAt }` in
  `.trash/trash.json`. "All notes" offers "Undo" right after a delete and a "Recently deleted"
  view with "Restore". Nothing is ever deleted for good in this version.
- The frontend never gets file system access; content goes through commands (`list_notes`,
  `read_note`, `write_note`, `create_note`, `set_note_color`, `set_note_on_top`, `delete_note`,
  `list_trash`, `restore_note`, `open_note`, `close_note`, `open_hub`, settings commands).
  Writes are debounced in the frontend (500 ms after the last keystroke and on blur or close).
- Note content is never logged; error messages never contain content.
- `settings.json` next to it: `{ version: 1, language: null | <code>, theme: "system" | "light" |
  "dark", newNoteColor }`. "Start with the system" is the OS state itself (autostart plugin), not a
  stored copy.

### Colors
Eight own-named note colors, each with a light and a dark variant that keeps text at 4.5 : 1:
Lemon (default), Peach, Mint, Sky, Lilac, Rose, Sand, Slate. The app chrome uses Hangar's tokens.

### Code layout
- `src-tauri/src/store.rs`: the notes domain (index, content, trash, recovery), no Tauri types.
- `src-tauri/src/bounds.rs`: placing windows onto visible monitors (pure).
- `src-tauri/src/settings.rs`, `src-tauri/src/windows.rs` (create, show, remember bounds,
  debounced, native window theme from the theme setting), `src-tauri/src/tray.rs`,
  `src-tauri/src/commands.rs` (thin, no logic).
- `src-tauri/src/replies.rs` (pure): before a note window ends, the note saves first. Deleting an
  open note from "All notes" sends `note-delete-requested`; the note saves and deletes itself, or
  answers `note_flushed(false)`, and then nothing is deleted, the note keeps showing "Not saved" and
  "All notes" says why. "Quit" sends `note-flush-requested` to every note window and quits once all
  answered; a note that could not save keeps the app open and comes to the front. "Quit" chosen
  again within 10 s after that ends the app anyway (`QUIT_ANYWAY_WITHIN`), so a note that can never
  save cannot trap the user in the app. A note that does not answer within 2 s does not block
  either (fallback: delete, quit). Requests to one note use
  `emit_to` its label, and the note listens for its own label only.
- Leaving an unsaved note (added 2026-11-26, `src/leaveAnyway.ts`): when a save keeps failing (or
  the text is over 1 MiB), switching notes in the notes area (another note, the list, a new note,
  the trash, the settings) and closing a sticky note are refused first, with a warning that the
  unsaved text is lost on a second try and "Copy as Markdown" (`copy_text`: the backend's
  clipboard plugin, notes area and sticky notes only, at most 1 MiB, never logged). A second try
  within 10 s leaves anyway, as "Quit" does. Requests from the command line or Hangar never drop
  text this way.
- `src/main.tsx` picks the view by window label (one React root, kept across hot reloads by
  `src/hotRoot.ts`); `src/NoteWindow.tsx`, `src/Hub.tsx`,
  `src/editor.ts` (CodeMirror setup), `src/api.ts` (typed command wrappers), `src/i18n.ts`
  (12 languages as in Hangar), `src/shortcuts.ts`, `src/colors.ts`, `src/styles.css`,
  `src/menuKeys.ts` (keyboard use of the popup menus after the WAI-ARIA menu pattern: Arrow Up and
  Down, Home, End; Escape closes and returns the focus to the button that opened the menu),
  `src/browserGuard.ts` (the WebView's own context menu only in text fields and the editor; in
  release builds no reloading, printing or find bar by F5, Ctrl+R, Ctrl+P, Ctrl+F, F3).
- Shortcuts in the note: Ctrl+N new note, Ctrl+B bold, Ctrl+I italic, Ctrl+Shift+X strikethrough,
  Ctrl+Shift+8 bullet list, Ctrl+Shift+9 checklist item (Cmd on macOS); Escape leaves the
  formatting bar. Letters match the letter the layout types (Dvorak), and the key position on
  layouts without Latin letters; digits match the key position; AltGr never triggers a shortcut.
  Defined only in `src/shortcuts.ts`, with tests.

### Identity and versions
Product name "Hangar Note", identifier `com.feoren.hangar-note`, version 0.1.0 with the build
number from Git as in Hangar. Updater and release script follow with the first release.

## Non-goals (this version)
> [!warning] Superseded in part
> [[0002-hangar-notes-takeover]] (2026-11-26) makes team notes, encryption and Hangar's notes data
> goals: Hangar Note takes over Hangar's notes area and uses its storage in place.

- Sync between devices, sharing with a team, encryption.
- Images, ink, attachments, reminders.
- Reading or writing Hangar's notes or any other Hangar data.
- Rich text beyond Markdown.
- Mobile platforms.
- Updater, installer signing and release script (part of the first release).

## Anti-goals
- A note that loses text: on a crash, a quit or a full disk, at most the last 500 ms of typing may
  be missing, never a whole note.
- More controls than Sticky Notes: when in doubt, leave it out.

## Consequences
- Many small windows: each note window is a WebView; with dozens of open notes memory grows
  (roughly tens of MB per WebView on Windows, [UNVERIFIED]). Accepted; hidden notes have no window.
- Frameless windows need their own drag region and resize edges per platform; on Linux behavior
  depends on the compositor ([UNVERIFIED]).
- Because content is plain Markdown in `.md` files, a later bridge to Hangar's notes needs no
  conversion.
- Later candidates: Hangar integration (open a note from Hangar, show a Hangar note as a sticky
  note), encrypted sync through the Hangar relay, updater and release.

## Evidence
- Hangar's notes storage and contract (Hangar ADR 0004 and its notes contract) as the model for the
  file layout and the atomic writes.
- Tauri `app_local_data_dir` = `dirs::data_local_dir()/<identifier>`, checked in Hangar against
  tauri 2.12.5 `src/path/desktop.rs`.
- Event delivery, checked against tauri 2.12.7 `src/event/listener.rs` (`match_any_or_filter`): a
  JS listener with the default target `Any` receives events sent with `emit_to` to any other
  label too, so per-note requests listen with `{ target: <own label> }`.
- Browser keys, checked against wry 0.57.4 (`with_browser_accelerator_keys`, applied in
  `src/webview2/mod.rs`) and tauri-runtime-wry 2.12.5, which never calls it and offers no config
  for it: Tauri 2.12 cannot switch WebView2's browser keys off, hence the frontend guard.
