---
title: "ADR 0002: Hangar Note takes over Hangar's notes"
type: decision
status: accepted
superseded_by:
tags: [hangar, notes, integration, team, e2e, ipc, storage, migration]
sources: []
created: 2026-11-26
updated: 2026-11-26
---

# ADR 0002: Hangar Note takes over Hangar's notes

## Context
The owner decided on 2026-11-26: Hangar Note takes over the complete notes area of Hangar,
private and team. Everything Hangar offers for notes must exist in Hangar Note; afterwards the
notes area is removed from Hangar. Hangar Note must be fully in sync and connected with Hangar, and
once Hangar Note is installed, Hangar offers a way to start and use it directly. Notes can also be
categorized by color.

This supersedes the non-goals of [[0001-foundation]] that excluded team notes, encryption and access
to Hangar's data. The sticky note windows of ADR 0001 stay: any note can be shown on the desktop.

### What exists in Hangar 0.17.0 (inventory of 2026-11-26, Hangar code)
- **Private notes** (Hangar ADR 0004): `<Hangar local data>/notes/<scope>/` with scope `general` or
  32 hex digits of SHA-256 over the normalized working folder; `folder.json`
  `{ version: 1, path, notes: [{ id, title, file, order }] }`, parsed with `deny_unknown_fields`;
  `<title>.md` (UTF-8, at most 1 MiB, atomic writes); `.trash/` with `trash.json`.
  Features: scopes "This project", "All", "General", another project; create, quick note
  (Ctrl+Shift+N), automatic title, rename (F2), search (title first, 50 hits), trash with undo and
  "Recently deleted", export, show in file manager, copy as Markdown, Markdown editor with
  checkboxes, preview, progress and word count, send to session, add terminal selection to a note,
  detached panel window with "Always on top".
- **Shared project notes** (Hangar ADR 0006): `<main worktree>/.hangar/notes/` with `vault.json`
  (`format: 1`, `solo` with a code slot or `team`), `<uuid>.note` sealed with XChaCha20-Poly1305
  through `hangar-team-crypto` (format `hangar-note 1`), inner meta line `{"v":1,title,created,
  updated,by}`; solo mode with a recovery code, team mode with the team's notes key ring;
  automatic Git conflict handling; move between private and shared; old key marks; save lock while
  a key is renewed. Keys in the OS keychain under the service `hangar-notes`
  (`notes/<vault>`, `team/<team key>`).
- **Couplings:** team decisions (Hangar ADR 0021) are sealed with the newest key of the notes key
  ring; one Hangar process per team holds the relay connection (lock file); the handover, the daily
  review ("To notes"), the quick launcher search, the terminal context menu and telemetry use notes.
- **No external interface:** no deep links, second-start arguments are ignored, the local hook
  endpoint only serves Hangar's own sessions by token.

## Options

### A. Hangar stays the engine, Hangar Note is only a window onto it
All storage and crypto stay in Hangar; Hangar Note calls Hangar over a local channel.
Sync is trivial (one writer), but Hangar Note is useless whenever Hangar is not running, and
Hangar keeps all notes code. That is not "taking over". Rejected.

### B. Hangar Note owns notes completely, including the team key ring
Hangar Note would need its own relay connection, which the one-process-per-team rule forbids, and
the decision records in Hangar would lose their key. Rejected.

### C. Hangar Note owns the notes, Hangar keeps the team keys (chosen)
Hangar Note is the only program that reads and writes notes. It uses `hangar-team-crypto` for
sealing and opening (vendored like the Hangar relay does). Hangar keeps the relay connection and the
notes key ring and hands the ring to Hangar Note over an authenticated local channel. Hangar reaches
notes only through Hangar Note.

### Storage location for the takeover
1. **In place:** Hangar Note reads and writes Hangar's existing folders and formats unchanged.
   No migration, nothing to lose, Hangar and Hangar Note can be rolled back independently. Couples
   Hangar Note to Hangar's data folder name.
2. **Migrate** into Hangar Note's own folder once, then Hangar never touches it. Cleaner ownership,
   but a one-time move of real user data with its own failure modes.

## Decision
Option C, storage in place (option 1; the owner chose it on 2026-11-26). Hangar Note reads and
writes Hangar's existing notes folders and formats unchanged; nothing is migrated.

### Ownership and the single writer
- From the moment Hangar detects an installed Hangar Note with a compatible contract version,
  Hangar stops writing notes files and hides its own notes area. Hangar Note is the only writer.
- A writer lock file `notes/.writer.lock` (held open, OS file lock) guards the private notes root;
  a second writer refuses to start writing. Same for each `.hangar/notes/` folder through a lock
  file in Hangar Note's local data keyed by the vault id.
- **Handover marker.** Hangar writes `notes/.handover.json` `{ version: 1, contract: 1, since }`
  (since in Unix ms) into its private notes root at the moment it stops writing notes there.
  Until that file exists, Hangar Note opens Hangar's notes **read only** with a calm hint
  ("Hangar still keeps these notes. Update Hangar to edit them here."), because a Hangar without the
  handover code keeps writing the same files. Hangar never removes the marker on its own; a
  downgrade of Hangar is the only case that needs the person.
- **Development root.** `HANGAR_NOTE_NOTES_ROOT` (environment, debug builds only) points Hangar
  Note at another private notes root with Hangar's layout. That root counts as handed over, so
  development and tests never touch the person's real notes.
- Index files stay readable by the released Hangar: Hangar Note never adds fields to `folder.json`,
  `trash.json`, `vault.json` or the inner meta line of a `.note` while any Hangar release that rejects
  unknown fields is supported. Additional data (colors, color names, sticky window places) lives in
  Hangar Note's own `meta.json` keyed by scope and note id, and for shared notes in a sealed sidecar
  only once Hangar tolerates it (see the phases).

### Detection and start
- Hangar Note writes `<Hangar Note local data>/install.json` on every start:
  `{ version: 1, contract: 1, exe, appVersion }`. Hangar reads it (path from the known identifier
  `com.feoren.hangar-note`) and checks that `exe` exists. This works the same on every platform and
  needs no registry.
- Hangar starts Hangar Note as an argv array (never a shell string):
  `hangar-note open [--folder <path>] [--shared] [--note <id>]`,
  `hangar-note quick [--folder <path>]`, `hangar-note capture --folder <path>` (text on stdin, at most
  1 MiB). Hangar Note's single instance forwards these to the running app.
- Without an installed Hangar Note, Hangar shows "Install Hangar Note" where the notes area was.

### Local channel (both directions)
- Loopback HTTP on 127.0.0.1 with a random port, one per app. Each app writes `endpoint.json`
  `{ version: 1, port, token }` into its local data folder with user-only permissions; the token is
  32 random bytes, rotated on every start. Requests carry `Authorization: Bearer <token>`; browser
  `Origin` headers and foreign `Host` values are rejected, as in Hangar's hook endpoint.
- **Hangar to Hangar Note:** `open`, `quick`, `capture`, `create` (daily review), `search`
  (quick launcher), `excerpts` (handover), `flush` (before Hangar quits).
- **Hangar Note to Hangar:** `sessions` (working folders and labels of running sessions, for "This
  project" and "Send to session"), `send` (paste into a session, never with Enter), `team/status`
  and `team/ring` for a folder (the `NotesKeysView`: ring, freshness, renewing, manager), team
  actions `team/enable`, `team/link`, `team/to-team`, and an event stream (`team-changed`,
  `sessions-changed`) as server-sent events.
- Every message has a version; an unknown version gets a clear error, never a guess.

### Team notes
- The ring is held in memory only; Hangar Note may read the keychain cache `team/<team key>` and
  must honor its `stale` flag (read only when stale). Saving follows Hangar's save rule unchanged:
  no write while the key is renewed or the ring is not fresh.
- Solo vaults (recovery code) work without Hangar: Hangar Note reads and writes the solo ring in the
  keychain entry `hangar-notes/notes/<vault>`.
- Team mode needs a running Hangar for fresh keys; without it, team notes are read only with a calm
  hint ("Start Hangar to edit team notes").

### Features in Hangar Note
Everything listed under "What exists", plus:
- **Sticky notes** ([[0001-foundation]]): any note, private or shared, can be shown as its own
  window on the desktop.
- **Color categories:** every note has one of the eight colors; the notes list filters by one or
  more colors; each color can get an own name (a personal setting). The color of a shared note is
  shared with the team once the sealed sidecar exists (phase 3); until then it is personal.

### Phases
1. **Hangar Note, private:** private notes in place with the full feature set, colors, sticky
   windows, CLI commands, `install.json`, own endpoint. Hangar unchanged except tolerant parsing.
2. **Hangar:** reads `install.json`, starts Hangar Note, shows "Open in Hangar Note", stops writing
   notes when it is installed, serves `sessions`, `send` and the event stream, routes the daily
   review, the capture and the launcher search to Hangar Note.
3. **Shared notes:** solo and team vaults in Hangar Note, `team/*` routes in Hangar, sealed color
   sidecar.
4. **Hangar:** removes the notes UI (keeps the panel for Changes and Files, keeps the notes key ring
   engine for decisions).

## Consequences
- Two apps must agree on one versioned contract; changes go through both sessions.
- Hangar's notes code shrinks to the key ring engine and the contract routes; its notes tests move
  to Hangar Note.
- Hangar's private notes folder name stays `com.feoren.hangar` even though Hangar Note owns it
  (in-place option).
- [UNVERIFIED] Whether the macOS keychain lets a second app with another bundle identifier read
  the `hangar-notes` entries; until measured, macOS gets team keys only over the channel.

## Evidence
- Inventory of Hangar 0.17.0 code and wiki on 2026-11-26 (notes, project notes, team crypto, panel
  window, hook endpoint, single instance); file and line references kept in the Hangar session.
