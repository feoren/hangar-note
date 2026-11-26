---
title: Hangar's private notes format (as Hangar Note reads and writes it)
type: concept
tags: [notes, storage, format, hangar, compatibility]
sources: []
created: 2026-11-26
updated: 2026-11-26
---

# Hangar's private notes format

Hangar Note keeps Hangar's private notes in place ([[0002-hangar-notes-takeover]]) and writes them
at the same time as Hangar ([[0005-shared-notes-folder]], contract "notes-shared 1"). This page records
what the format is, as verified on 2026-11-26 against Hangar 0.17.0's `src-tauri/src/notes.rs` and
against the layout of a real notes folder (read only: keys and formatting checked, no content).

## Layout
```text
<local data>/com.feoren.hangar/notes/
  general/                  General area
  <32 hex>/                 a working folder: SHA-256 of the normalized path, first 16 bytes
    folder.json             { version: 1, path, notes: [{ id, title, file, order }] }
    <title>.md              UTF-8 Markdown, at most 1 MiB
    .lock                   scope lock (empty), held around every change of folder.json and trash.json
    .trash/
      <millis>-<file>.md    deleted notes
      trash.json            { version: 1, items: [{ id, title, file, deletedAt }] }
  .writer.lock              held by the one writing Hangar Note (Hangar does not take it)
```

## Two writers (contract "notes-shared 1", [[0005-shared-notes-folder]])
- Every read-modify-write of `folder.json` or `.trash/trash.json` holds an exclusive OS file lock
  on `<scope>/.lock`, waits for it at most 2 s (`try_lock` every 10 ms; on timeout the storage code
  `io`), reads the file again from disk under it and writes it atomically.
- A note is written only while its file still has the version the editor read
  (`<mtime_ns>-<len>`, else `changed`); new files never replace one that appeared meanwhile, moves
  never replace a file, a delete moves whatever the file holds into the trash.
- Hangar Note polls the folder once a second and tells its windows about changes it did not make.
- `.handover.json` of ADR 0002 is no longer read; a leftover one changes nothing.

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
  does the same, but only while it may write (that move does not take the scope lock; by the time
  both apps run, Hangar has already done it).
- Read only (another Hangar Note holds `.writer.lock`, or the folder cannot be locked), Hangar Note
  writes nothing into the folder, not even a scope lock file.

## Evidence
- Hangar 0.17.0 `src-tauri/src/notes.rs` and its tests, ported to `src-tauri/src/notes.rs` here.
- Read-only look at a real notes folder on Windows 11 on 2026-11-26: two working folder scopes and
  `general`, `folder.json` keys `version, path, notes`, pretty printed, no trailing newline, no CR.
