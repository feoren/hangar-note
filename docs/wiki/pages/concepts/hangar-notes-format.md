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
    .lock                   scope lock (empty), held around every change of folder.json, trash.json and a note
    .<name>.<pid>.<n>.tmp   temporary file of an atomic write in progress (either app); never a note
    .trash/
      <millis>-<file>.md    deleted notes
      trash.json            { version: 1, items: [{ id, title, file, deletedAt }] }
  .writer.lock              held by the one writing Hangar Note (Hangar does not take it)
```

## Two writers (contract "notes-shared 1", [[0005-shared-notes-folder]])
- Every read-modify-write of `folder.json` or `.trash/trash.json`, and every write of a note's
  text, holds an exclusive OS file lock on `<scope>/.lock`, waits for it at most 2 s (`try_lock`
  every 10 ms; on timeout the storage code `io`), reads the file again from disk under it and
  writes it atomically.
- Atomic write: `.<name>.<pid>.<n>.tmp` in the same folder, `sync_all`, rename over the target.
  On Windows a rename refused because the other app holds the target open is tried again every
  15 ms for at most 1 s, then fails (`denied`); never an in-place write, the temporary file is
  always removed on failure. Listers and the watcher skip every dotfile and every `*.tmp`.
- A note's version is the SHA-256 of its bytes (64 lowercase hex digits). A note is written only
  while, under the scope lock, its file still hashes to the version the editor read (else
  `changed`); the write returns the hash of the bytes written. New files never replace one that
  appeared meanwhile, moves never replace a file, a delete moves whatever the file holds into the
  trash.
- Hangar Note polls the folder once a second and tells its windows about changes it did not make.
- `.handover.json` of ADR 0002 is no longer read; a leftover one changes nothing.

## Facts that matter for compatibility
- Hangar 0.17.0 parses `folder.json` and `trash.json` with `deny_unknown_fields`: one extra field
  makes Hangar set the file aside and adopt the notes again under **new IDs**. Hence Hangar Note's
  own data lives in `meta.json`, never in these files: Hangar Note adds no field.
- Hangar Note parses both tolerantly (since the amendments of [[0005-shared-notes-folder]],
  2026-11-26): every unknown field, at the top and in each entry, is kept and written back after
  the known fields (sorted by name), so a newer Hangar's fields survive a rewrite
  (`unknown_fields_survive_a_rewrite`). Each entry is parsed on its own; one that does not parse is
  skipped, the rest of the file still counts.
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
- The folder is untrusted. Entries naming anything but a plain `.md` file of the folder (a path,
  root or drive, `..`, a separator or forbidden character, a control character, a leading dot, a
  Windows device name such as `CON.md`, more than 255 bytes) or carrying an ID that is not a
  canonical lowercase UUID are skipped on read with a log line that names no title, and dropped on
  the next rewrite, so an edited index cannot point the store at a foreign file. Files are adopted
  only under names that pass the same check.
- Links are never followed: symbolic links, junctions and on Windows every reparse point count as
  "not a folder" or "not a note" (scope folders, trash, note files, the lock file); notes are opened
  with `FILE_FLAG_OPEN_REPARSE_POINT` and checked on the handle.
- Size caps: 1 MiB per note, 4 MiB per index file.
- An index file that exists but cannot be used (broken JSON, unknown version, too large, a link) is
  never rewritten, set aside or emptied: notes are listed from the files under IDs derived from
  scope and file name and stay readable and writable; create, rename, delete and restore that need
  `folder.json` are refused with `io` until it is fixed. A broken `trash.json` stays as it is while
  delete and restore still move files.
- Hangar renames the old German folders `allgemein/` and `.papierkorb/` on every start; Hangar Note
  does the same, but only while it may write (that move does not take the scope lock; by the time
  both apps run, Hangar has already done it).
- Read only (another Hangar Note holds `.writer.lock`, or the folder cannot be locked), Hangar Note
  writes nothing into the folder, not even a scope lock file.

## Evidence
- Hangar 0.17.0 `src-tauri/src/notes.rs` and its tests, ported to `src-tauri/src/notes.rs` here.
- Read-only look at a real notes folder on Windows 11 on 2026-11-26: two working folder scopes and
  `general`, `folder.json` keys `version, path, notes`, pretty printed, no trailing newline, no CR.
