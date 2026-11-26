---
title: Overview
type: overview
tags: [overview]
sources: ["[[llm-wiki-pattern]]", "[[version-number-wikipedia]]"]
created: 2026-11-25
updated: 2026-11-26
---

# Overview

## State of knowledge
- The wiki was set up on 2026-11-25 following [[llm-wiki-pattern]].
- [[0001-foundation]] settles window model and editor: sticky notes on the desktop.
- [[0002-hangar-notes-takeover]] makes Hangar Note the owner of Hangar's notes, private and team, with
  a contract between both apps. Phase 1 is built: Hangar's private notes in place
  ([[hangar-notes-format]]), and the local channel ([[local-channel]]).
- [[0005-shared-notes-folder]] replaces the handover: Hangar and Hangar Note write Hangar's private
  notes at the same time, with a scope lock, version checks and a one-second poll.
- [[0003-version-scheme]] takes over Hangar's version scheme `X.Y.Z-B` ([[version-number-wikipedia]]):
  the code carries the upcoming version 0.1.0, which heads `src/changelog.json`, and
  `src/versionSync.test.ts` keeps both in step. The release script follows with the first release.

## Open questions
- Whether the updater and the NSIS bundler treat `X.Y.Z+B` in Hangar Note's own build as in
  Hangar's (comparison by `X.Y.Z`, Windows file version `X.Y.Z.B`), unmeasured until the first
  release build.
- Memory use with many open note windows (one WebView each), unmeasured.
- Frameless windows on Linux compositors, unmeasured.
- macOS keychain access to `hangar-notes` entries from a second app, unmeasured.
- Whether a GUI-subsystem release build reads a piped stdin for `capture` on Windows, unmeasured
  (the debug build, a console program, was measured).

## Open risks
- Until Hangar adopts contract "notes-shared 1" (scope lock, version check), a change of Hangar and
  one of Hangar Note at the same moment can lose an index entry (the note comes back under a new
  ID), and Hangar can overwrite a note open in both apps ([[0005-shared-notes-folder]]).
