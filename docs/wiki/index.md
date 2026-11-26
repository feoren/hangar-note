# Index

Catalog of all wiki pages. Updated on every ingest.

## Overview
- [[overview]]: state of knowledge, open risks and questions (sources: 2, updated: 2026-11-26)

## Decisions
- [[0004-switchable-looks]]: accepted: the looks "Calm" (default), "Paper" and "Hangar" as one setting over one shared notes area; every function in every look, switching without a restart; the sticky note follows the look (sources: 0, updated: 2026-11-26)
- [[0003-version-scheme]]: accepted: Hangar's scheme `X.Y.Z-B`; internally `X.Y.Z+B` (Windows file version `X.Y.Z.B`), shown and in file names `X.Y.Z-B`; B = commit count of the built state, set only when building, no base; the code carries the upcoming version, the topmost entry of `src/changelog.json` (12 languages, `date: null` until the release); `src/versionSync.test.ts`; release script rules for the first release (sources: 1, updated: 2026-11-26)
- [[0002-hangar-notes-takeover]]: accepted: Hangar Note takes over Hangar's notes area, private and team; Hangar Note is the only writer and uses Hangar's folders and formats in place, Hangar keeps the team key ring and hands it over a token-protected loopback channel; detection through `install.json`, start through `hangar-note open|quick|capture`; color categories; four phases; section "Phase 1 as built" (sources: 0, updated: 2026-11-26)
- [[0001-foundation]]: accepted: sticky notes on the desktop: one frameless window per note plus an "All notes" window and a tray icon; one `.md` per note plus `notes.json` in the app data folder, atomic writes, trash with restore; CodeMirror 6 Markdown with live styling; eight note colors; no access to Hangar's data; non-goals sync, sharing, images (sources: 0, updated: 2026-11-26)

## Components

## Platforms

## Concepts
- [[hangar-notes-format]]: Hangar's private notes layout and the facts that keep it compatible (`deny_unknown_fields`, pretty JSON without trailing newline, path normalization and a known key value, read-only rules) (sources: 0, updated: 2026-11-26)

## Syntheses
- [[usability-pass]]: the notes area walked through as a first-time user and the phase 1 review findings: capture and quick note while read only, no switching away from unsaved text, start scope All, color filter targets and rings, trash hints, empty states with one button each, errors at the bottom, direction A as built (title menu, row tools and context menu, one notice place, error sentences, calm sticky note), its rework, and the looks Paper and Hangar as built (cards and sheet, three columns and status bar, the sticky note per look, contrast per surface); finding, change, reason (sources: 0, updated: 2026-11-26)
- [[local-channel]]: contract version 1 of the command line, `install.json`, `endpoint.json` and the loopback routes on Hangar Note's side, with the server proof, the checks, the connection slots, the capture exit codes and the error codes (sources: 0, updated: 2026-11-26)

## Sources
- [[version-number-wikipedia]]: German Wikipedia "Versionsnummer" (revision 267798157): major, minor, revision and build number, the build number from version control and never reset, major version 0 as an exception (sources: 0, updated: 2026-11-26)
- [[llm-wiki-pattern]]: Karpathy's LLM Wiki pattern: raw sources, LLM-written pages and a schema; ingest, query and lint; `index.md` as catalog and `log.md` as chronicle (sources: 0, updated: 2026-11-25)
