# Index

Catalog of all wiki pages. Updated on every ingest.

## Overview
- [[overview]]: state of knowledge, open risks and questions (sources: 1, updated: 2026-11-25)

## Decisions
- [[0002-hangar-notes-takeover]]: accepted: Hangar Note takes over Hangar's notes area, private and team; Hangar Note is the only writer and uses Hangar's folders and formats in place, Hangar keeps the team key ring and hands it over a token-protected loopback channel; detection through `install.json`, start through `hangar-note open|quick|capture`; color categories; four phases; section "Phase 1 as built" (sources: 0, updated: 2026-11-26)
- [[0001-foundation]]: accepted: sticky notes on the desktop: one frameless window per note plus an "All notes" window and a tray icon; one `.md` per note plus `notes.json` in the app data folder, atomic writes, trash with restore; CodeMirror 6 Markdown with live styling; eight note colors; no access to Hangar's data; non-goals sync, sharing, images (sources: 0, updated: 2026-11-26)

## Components

## Platforms

## Concepts
- [[hangar-notes-format]]: Hangar's private notes layout and the facts that keep it compatible (`deny_unknown_fields`, pretty JSON without trailing newline, path normalization and a known key value, read-only rules) (sources: 0, updated: 2026-11-26)

## Syntheses
- [[usability-pass]]: the notes area walked through as a first-time user and the phase 1 review findings: capture and quick note while read only, no switching away from unsaved text, start scope All, color filter targets and rings, trash hints, empty states with one button each, errors at the bottom; finding, change, reason (sources: 0, updated: 2026-11-26)
- [[local-channel]]: contract version 1 of the command line, `install.json`, `endpoint.json` and the loopback routes on Hangar Note's side, with the server proof, the checks, the connection slots, the capture exit codes and the error codes (sources: 0, updated: 2026-11-26)

## Sources
- [[llm-wiki-pattern]]: Karpathy's LLM Wiki pattern: raw sources, LLM-written pages and a schema; ingest, query and lint; `index.md` as catalog and `log.md` as chronicle (sources: 0, updated: 2026-11-25)
