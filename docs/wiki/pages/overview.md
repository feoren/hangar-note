---
title: Overview
type: overview
tags: [overview]
sources: ["[[llm-wiki-pattern]]"]
created: 2026-11-25
updated: 2026-11-26
---

# Overview

## State of knowledge
- The wiki was set up on 2026-11-25 following [[llm-wiki-pattern]].
- [[0001-foundation]] settles window model and editor: sticky notes on the desktop.
- [[0002-hangar-notes-takeover]] makes Hangar Note the owner of Hangar's notes, private and team, with
  a contract between both apps. Phase 1 is built: Hangar's private notes in place
  ([[hangar-notes-format]]), read only until Hangar hands them over, and the local channel
  ([[local-channel]]).

## Open questions
- Memory use with many open note windows (one WebView each), unmeasured.
- Frameless windows on Linux compositors, unmeasured.
- macOS keychain access to `hangar-notes` entries from a second app, unmeasured.
- Whether a GUI-subsystem release build reads a piped stdin for `capture` on Windows, unmeasured
  (the debug build, a console program, was measured).

## Open risks
- Hangar before phase 2 writes no handover marker, so a released Hangar Note opens Hangar's notes
  read only until then; a development root is needed to edit.
