---
title: Hangar's private notes format (as Hangar Note reads and writes it)
type: concept
tags: [notes, storage, format, hangar, compatibility]
sources: []
created: 2026-11-26
updated: 2026-11-26
---

# Hangar's private notes format

Hangar Note keeps Hangar's private notes in place ([[0002-hangar-notes-takeover]]). This page records
what the format is, as verified on 2026-11-26 against Hangar 0.17.0's `src-tauri/src/notes.rs` and
against the layout of a real notes folder (read only: keys and formatting checked, no content).

## Layout
```text
<local data>/com.feoren.hangar/notes/
  general/                  General area
  <32 hex>/                 a working folder: SHA-256 of the normalized path, first 16 bytes
    folder.json             { version: 1, path, notes: [{ id, title, file, order }] }
    <title>.md              UTF-8 Markdown, at most 1 MiB
    .trash/
      <millis>-<file>.md    deleted notes
      trash.json            { version: 1, items: [{ id, title, file, deletedAt }] }
  .handover.json            written by Hangar when it stops writing (phase 2), never by Hangar Note
  .writer.lock              held by Hangar Note once the folder is handed over
```

## Facts that matter for compatibility
- `folder.json` and `trash.json` are parsed with `deny_unknown_fields` in Hangar: one extra field
  makes Hangar set the file aside and adopt the notes again under **new IDs**. A test in
  `src-tauri/src/notes.rs` (`an_unknown_field_is_hangars_rejection_too`) shows that effect. Hence
  Hangar Note's own data lives in `meta.json`, never in these files.
- Hangar writes both with `serde_json::to_vec_pretty`: two-space indent, `": "`, no trailing
  newline, LF only. The real folder showed exactly that; Hangar Note writes the same bytes
  (`the_files_are_byte_for_byte_hangars_format`).
- Normalization before hashing: separators unified, `.` and doubled separators removed, no trailing
  separator, `\\?\C:\` as `C:\`, `\\?\UNC\s\x` as `\\s\x`, lowercase on Windows; no `..`
  resolution, no canonicalization. A known value: `C:\x` hashes to
  `6e6ef9e1f001ea8d5164e716aaf511bf` (computed independently with Python's hashlib).
- File names follow titles (`file_stem`: forbidden characters to `_`, no leading dot, reserved
  device names prefixed, at most 80 characters, duplicates get ` (2)`); IDs (UUID v4) live only in
  `folder.json`.
- Entries naming anything but a plain `.md` file of the folder are dropped on read, so an edited
  index cannot point the store at a foreign file.
- Hangar renames the old German folders `allgemein/` and `.papierkorb/` on every start; Hangar Note
  does the same, but only while it may write.

## Evidence
- Hangar 0.17.0 `src-tauri/src/notes.rs` and its tests, ported to `src-tauri/src/notes.rs` here.
- Read-only look at a real notes folder on Windows 11 on 2026-11-26: two working folder scopes and
  `general`, `folder.json` keys `version, path, notes`, pretty printed, no trailing newline, no CR.
