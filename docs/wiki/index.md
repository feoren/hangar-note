# Index

Catalog of all wiki pages. Updated on every ingest.

## Overview
- [[overview]]: state of knowledge, open risks and questions (sources: 2, updated: 2026-11-26)

## Decisions
- [[0005-shared-notes-folder]]: accepted: contract "notes-shared 1": Hangar and Hangar Note write Hangar's private notes at the same time, no handover marker, no read-only phase; scope lock `<scope>/.lock` (2 s wait, code `io`) around every change of `folder.json` and `trash.json`, version checks for notes, no file ever replaced, a one-second poll for outside changes; residual risk until Hangar adopts it; security review: lock file not deletable while held, identity and single-name checks, non-JSON indexes set aside, stale temp sweep; second review: cleaned titles, 5000 entries and a byte budget per index, reads without the lock, bounded listings (sources: 0, updated: 2026-11-27)
- [[0004-switchable-looks]]: accepted, amended 2026-11-27: the looks "Hangar" (default, with a narrow layout of its own) and "Paper" as one setting over one shared notes area; "Calm" removed, a stored "calm" reads as "hangar"; paper opens a note only by choice; the sticky note follows the look (sources: 0, updated: 2026-11-27)
- [[0003-version-scheme]]: accepted: Hangar's scheme `X.Y.Z-B`; internally `X.Y.Z+B` (Windows file version `X.Y.Z.B`), shown and in file names `X.Y.Z-B`; B = commit count of the built state, set only when building, no base; the code carries the upcoming version, the topmost entry of `src/changelog.json` (12 languages, `date: null` until the release); `src/versionSync.test.ts`; release script rules and updater rules for the first release (sources: 1, updated: 2026-11-26)
- [[0002-hangar-notes-takeover]]: accepted: Hangar Note takes over Hangar's notes area, private and team; Hangar Note is the only writer and uses Hangar's folders and formats in place, Hangar keeps the team key ring and hands it over a token-protected loopback channel; detection through `install.json`, start through `hangar-note open|quick|capture`; color categories; four phases; section "Phase 1 as built"; single writer and handover superseded for private notes by [[0005-shared-notes-folder]] (sources: 0, updated: 2026-11-26)
- [[0001-foundation]]: accepted: sticky notes on the desktop: one frameless window per note plus an "All notes" window and a tray icon; one `.md` per note plus `notes.json` in the app data folder, atomic writes, trash with restore; CodeMirror 6 Markdown with live styling; eight note colors; no access to Hangar's data; non-goals sync, sharing, images; the Content Security Policy with Tauri's style nonce (sources: 0, updated: 2026-11-26)

## Components

## Platforms

## Concepts
- [[hangar-notes-format]]: Hangar's private notes layout and the facts that keep it compatible (Hangar's `deny_unknown_fields` and Hangar Note's tolerant parsing that keeps unknown fields, pretty JSON without trailing newline, path normalization and a known key value, the scope lock and the rules for two writers, content hash versions, untrusted entries and links, indexes of unknown shape left byte for byte and non-JSON ones set aside, the hardened lock file, stale temp sweep, read-only rules) (sources: 0, updated: 2026-11-26)

## Syntheses
- [[usability-pass]]: the notes area walked through as a first-time user and the phase 1 review findings: capture and quick note while read only, no switching away from unsaved text, start scope All, color filter targets and rings, trash hints, empty states with one button each, errors at the bottom, direction A as built (title menu, row tools and context menu, one notice place, error sentences, calm sticky note), its rework, and the looks Paper and Hangar as built (cards and sheet, three columns and status bar, the sticky note per look, contrast per surface) and their rework (card fade, progress once, trash per look, grid keys, sticky window titles), and the levels Private, Project and Team with a sidebar that folds away and resizes, and the colors as a category list with Hangar's header, the levels in the sidebar and no bars beside the notes, and the icon footer with a light and dark switch, the round fold button on one head line and the chosen row in its color; finding, change, reason (sources: 0, updated: 2026-11-27)
- [[local-channel]]: contract version 1 of the command line, `install.json`, `endpoint.json` and the loopback routes on Hangar Note's side, with the server proof, the checks, the connection slots, the capture exit codes and the error codes (sources: 0, updated: 2026-11-26)

## Sources
- [[version-number-wikipedia]]: German Wikipedia "Versionsnummer" (revision 267798157): major, minor, revision and build number, the build number from version control and never reset, major version 0 as an exception (sources: 0, updated: 2026-11-26)
- [[llm-wiki-pattern]]: Karpathy's LLM Wiki pattern: raw sources, LLM-written pages and a schema; ingest, query and lint; `index.md` as catalog and `log.md` as chronicle (sources: 0, updated: 2026-11-25)
