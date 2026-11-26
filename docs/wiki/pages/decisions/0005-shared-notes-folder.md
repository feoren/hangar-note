---
title: "ADR 0005: Hangar and Hangar Note share the private notes folder"
type: decision
status: accepted
superseded_by:
tags: [hangar, notes, storage, locking, sync, compatibility]
sources: []
created: 2026-11-26
updated: 2026-11-26
---

# ADR 0005: Hangar and Hangar Note share the private notes folder

## Context
[[0002-hangar-notes-takeover]] made Hangar Note the only writer of Hangar's private notes: until
Hangar wrote `notes/.handover.json`, Hangar Note opened the folder read only. No released Hangar
writes that marker, so on every PC with both apps Hangar Note could only read.

The owner decided on 2026-11-26: when Hangar and Hangar Note are both installed, Hangar Note has
full control over Hangar's private notes in Hangar's folder, in place and at once: list, read,
create, edit, rename, delete, trash and restore. There is no read-only phase and no handover
marker. Both apps write the same folder at the same time.

This page is contract **"notes-shared 1"**: what both writers do so that neither loses the other's
change. Shared project notes (`.hangar/notes/`, team vaults) are not part of it; they stay as
[[0002-hangar-notes-takeover]] describes.

## Options
1. **Handover gate (ADR 0002).** Hangar Note reads only until Hangar writes the marker. One writer,
   so no conflicts, but useless next to any Hangar released so far, and it needs a Hangar release
   before Hangar Note can edit anything.
2. **Both write, with locks and versions.** Each read-modify-write of an index file holds a lock
   both apps take; each note write carries the version the editor read; each app sees the other's
   changes within a second. Works next to today's Hangar at once; the protection is complete only
   once Hangar takes the same lock and checks the version as well.
3. **Only Hangar Note writes.** Hangar stops writing notes as soon as Hangar Note is installed.
   Simple for Hangar Note, but the same Hangar release as option 1 is needed first, and until then
   the person has two apps that both offer editing with nothing to keep them apart.

## Decision
Option 2, contract "notes-shared 1".

### Access
- Hangar's folder is writable from the start. `.handover.json` is neither read nor written; the
  read-only reason `notHandedOver` is gone.
- Read only remains for two real cases: another Hangar Note holds `notes/.writer.lock`
  (`otherWriter`), or the lock file cannot be created or locked (`lockFailed`, for example a folder
  without write permission). Hangar does not take `.writer.lock`; it only keeps Hangar Note
  instances apart.
- The development root `HANGAR_NOTE_NOTES_ROOT` (debug builds) is unchanged and still refused when
  it names Hangar's own folder.

### The scope lock
- File: `notes/<scope>/.lock`, next to the scope's `folder.json`. An exclusive OS file lock on it
  (`std::fs::File::lock` family: `LockFileEx` on Windows, `flock` on Unix) is held around every
  read-modify-write of that scope's `folder.json` and `.trash/trash.json`.
- Under the lock: read the current file from disk, apply the change, write it atomically (a
  temporary file in the same folder, then a rename), release. Never write from a copy kept in
  memory.
- Waiting: `try_lock` every 10 ms for at most 2 s. On timeout the operation fails with an I/O error
  of kind `TimedOut`, which reaches the window as the existing storage code `io`; nothing was
  written. No new error code.
- The lock file stays on disk after use (deleting a lock file races with the next taker); it is
  empty and is not a note: only `.md` files are notes, so neither app adopts it.
- Reading needs no lock: every write is atomic, so a reader sees the old or the new file. A read
  that finds a sync to save (a `.md` file without an entry, an entry without a file) takes the
  lock, reads again and saves only what it still finds.
- A read-only Hangar Note takes no scope lock and creates no lock file.

### Notes
- Every note write by an editor carries the version it read and is refused with `changed` when
  the file has another one; the editor then offers to reload or copy. The version was
  `<mtime_ns>-<len>` until amendment 3, now it is the SHA-256 of the content, checked under the
  scope lock (see "Amendments").
- A new note is created with "create new" semantics: if Hangar took the name between the check
  and the creation, the next free name is used, never the existing file.
- Rename and restore move with `rename_no_replace`, never over an existing file.
- Delete moves whatever the file holds at that moment into `.trash/`, also a text Hangar saved a
  moment before; restoring brings it back. The entry is removed from the `folder.json` read under
  the lock.

### Seeing the other app's changes
- Hangar Note polls once a second (`src-tauri/src/watch.rs`): the version of every scope's
  `folder.json`, `.trash/trash.json` and `.md` notes, plus the list of scope folders. A changed
  scope sends `notes-changed` to the notes area and `note-changed-outside` to each sticky note of
  that scope (whose window title also follows a rename).
- The app's own writes are recorded with the state they left the file in and are not reported, so
  typing does not reload the app's own list every second; a later write by Hangar has another
  version and is reported.
- A poll instead of the `notify` crate: no new dependency, the same behavior on every platform,
  and one directory listing plus one metadata call per file is cheap for a notes folder; at most
  5000 files are looked at per pass.

### What Hangar does under the contract
To be fully protected, Hangar adopts the same rules: take `<scope>/.lock` around its own
read-modify-writes of `folder.json` and `trash.json` (same wait, same atomic write), check the
version before overwriting a note an editor read earlier, and never create or move over an
existing file. Hangar may keep its own notes UI; nothing is handed over.

## Consequences
- Hangar Note edits Hangar's notes on every PC at once, next to any Hangar release.
- **Residual risk until Hangar adopts the contract:**
  - Hangar's own read-modify-writes of `folder.json` and `trash.json` do not take the scope lock,
    so a change of Hangar and one of Hangar Note at the same moment can still lose one entry. Both
    stores adopt a `.md` file without an entry again on the next read, so the note itself stays,
    only under a new ID (its color and sticky place in Hangar Note's `meta.json` are then
    orphaned).
  - Hangar overwrites a note that is open in both apps without a version check: when the person
    types in both, Hangar's save replaces Hangar Note's text. Hangar Note's next save of the same
    note is refused with `changed`, so Hangar Note does not overwrite Hangar's text in return, and
    nothing typed in Hangar Note is lost while its window still shows it (reload or copy).
  - The version check and the write of a note are not one step: a save of Hangar that lands
    between Hangar Note's check and its rename (the length of one write, a few milliseconds) is
    replaced. Closing this needs a lock on note files too, which the contract does not have yet.
    (Amendment 3 closes this for every Hangar that takes the scope lock around its note writes.)
- Changes made within a few milliseconds of an own write to the same file can be taken for the
  app's own and not reported; the next change, or the next reload of the list, shows them.
- `.handover.json` from ADR 0002 has no meaning any more; a Hangar that writes it changes nothing.
- The frontend's `notHandedOver` hint was removed with the backend state.

## Amendments

### 2026-11-26: adopted with Hangar and the owner
Hangar (lead of the contract) and the owner adopted "notes-shared 1" with these amendments. Both
apps implement them; numbering as agreed (amendment 1 concerns Hangar's side only).

**Amendment 2: atomic writes next to an open file.**
- The temporary file stays `.<name>.<pid>.<n>.tmp` in the target's folder (`<name>` the target's
  full file name, `<pid>` the process id, `<n>` a per-process counter), written, `sync_all`, then
  renamed over the target.
- On Windows the rename fails while the other app holds the target open without
  `FILE_SHARE_DELETE` (`ERROR_ACCESS_DENIED`, also `ERROR_SHARING_VIOLATION` and
  `ERROR_LOCK_VIOLATION`). The rename is then tried again every 15 ms for at most 1 s; after that
  the write fails with the storage code `denied`. There is never a fallback to writing the target
  in place, and the temporary file is removed on every failure. Other platforms replace an open
  file, so nothing is retried there.
- Listers and the watcher skip every dotfile and every `*.tmp`, so the other app's temporary
  files (and `.lock`) never show up as notes. A note's file name in an index entry may not start
  with a dot either.

**Amendment 3: the version is the content hash, checked under the lock.**
- A note's version is the SHA-256 of its bytes in lowercase hex (64 characters), taken when the
  note is read and returned as `version`. The window treats it as an opaque string, as before.
- Every note write takes the scope lock `<scope>/.lock` (same wait as for the index files), reads
  the file again, hashes it and compares with the version the editor holds; on a mismatch it
  answers `changed` and writes nothing, else it writes atomically while still holding the lock and
  returns the hash of the bytes it wrote (what the next read gives).
- The one-second poll keeps using modification time and length to notice changes; only the
  conflict decision is the hash. A rename keeps the hash, and so does another program saving the
  same bytes again.

**Untrusted shared folder.** `folder.json`, `trash.json` and the files around them come from a
folder another program writes:
- Each entry is parsed and checked on its own. An entry that does not parse, has an ID that is not
  a canonical lowercase UUID, or a file name that is not a plain `.md` name (a path, a root or
  drive, `..`, a separator, a character Windows refuses, a control character, a leading dot, a
  device name such as `CON.md`, more than 255 bytes) is skipped and never followed; the log names
  the scope, the file kind and the number skipped, no title. The lister adopts only file names
  that would pass the same check.
- Links are never followed: symbolic links, junctions and, on Windows, every reparse point count
  as "not a folder" or "not a note", for scope folders, the trash, note files and the lock file.
  A note is opened with `FILE_FLAG_OPEN_REPARSE_POINT` and refused when the handle is not a plain
  file, so a link swapped in after a look is refused too.
- The size caps stay: 1 MiB per note, 4 MiB per index file.
- An index file that exists but cannot be used (broken JSON, unknown version, too large, a link,
  unreadable) is never rewritten, set aside or emptied. (Narrowed by "Security review of the
  contract" below: content that is not JSON at all is now set aside; everything else stays as
  written here.) The scope's notes are listed from the
  files under IDs derived from scope and file name, can be read and their text saved; changes
  that need the index (create, rename, delete, restore for `folder.json`) are refused with the
  storage code `io` until the file is fixed. A broken `trash.json` is likewise left as is: deleting
  and restoring still move the files, without a record. This replaces the earlier "set aside as
  `folder.json.broken-<millis>` and rebuild" for these two files.
- Unknown fields survive: both files and their entries are parsed tolerantly (no
  `deny_unknown_fields` on Hangar Note's side any more); every unknown field is kept (`#[serde(flatten)]
  extra`) and written back after the known ones, which stay in Hangar's order. Unknown fields are
  written back sorted by name, not in their original order. Hangar Note itself still adds no field.
  A field of a deleted note's entry does not move into its trash record, nor back on a restore.

Residual risk after the amendments: a Hangar that does not yet take the scope lock around its note
writes can still land a save between Hangar Note's check and rename; a Hangar that still parses with
`deny_unknown_fields` rejects files that carry fields only a newer Hangar wrote (Hangar Note keeps
them, it does not add them).

### 2026-11-26: security review of the contract
Hangar's security review of "notes-shared 1" asked both apps for the following; Hangar does the
same on its side.

**L1: the lock file cannot be swapped away while held.**
- `<scope>/.lock` is opened on Windows with `FILE_SHARE_READ | FILE_SHARE_WRITE` only, without
  `FILE_SHARE_DELETE`: while either app holds it open, nobody can delete or rename it.
- After a successful `try_lock` the path is looked at again without following a link (Windows: a
  second open for attributes only with `FILE_FLAG_OPEN_REPARSE_POINT`, comparing volume serial
  number and file index from `GetFileInformationByHandle`; Unix: `lstat`, comparing device and
  inode). If the path is gone or names another file, the lock is dropped and taken again on the
  file there now, within the same 2 s wait. Without this, a `.lock` deleted or renamed between
  one app's open and its lock would let both apps hold "the" lock.

**L2: one name only.** A `.lock` with more than one name (a hard link, possibly to a foreign file)
is refused, checked on the handle at the open and again in the identity check. It is a lock
failure: storage code `io`, nothing written, the log names the scope and "scope lock", no title.

**The open itself does not follow links.** The open that creates the lock file uses
`FILE_FLAG_OPEN_REPARSE_POINT` (Windows) or `O_NOFOLLOW | O_NONBLOCK` (Unix), so a link, also a
dangling one, is never followed or created through, and a FIFO cannot hang it. The handle must be
a regular file (Windows: neither directory nor reparse point attribute). A link or folder in the
way is a lock failure (`io`). This replaces the earlier look before the open (a `symlink_metadata`
pre-check), which left a window between the look and the open.

**Index contract, as Hangar words it.**
- A `folder.json` or `trash.json` that is valid JSON but of an unknown version or shape is left
  byte for byte: the scope index is read only, as before (notes listed from the files, index
  changes refused with `io`; a broken `trash.json` still lets delete and restore move files).
  The same holds for a file that is too large, a link or unreadable.
- Only content that is not JSON at all (cut off, empty, binary, not UTF-8) is set aside as
  `<name>.broken-<millis>` in the same folder, under the scope lock and only by a writable store,
  with `rename_no_replace`: an existing `.broken-` file is never replaced, a second one in the
  same millisecond takes a `-<n>` suffix. The notes stay listed from disk; the next index is
  built from the same files under the same derived IDs (`stable_id`, the test vector of Hangar's
  ADR 0022, pinned in both apps), whichever app sets the file aside first. A note that already
  carried its derived ID keeps its color and sticky note in `meta.json`. A note whose random ID
  only the lost index knew gets its derived ID; its `meta.json` entry stays under the old ID and
  comes back only if the `.broken-` copy is restored by hand. The old IDs are not salvaged from
  the broken bytes: Hangar does not either, and both apps must arrive at the same IDs.
- Read only, nothing is set aside.

**Stale temporary files.** When a scope is opened for writing (under its lock), regular files
named exactly `.<name>.<pid>.<n>.tmp` (non-empty name, decimal pid and counter) older than 10
minutes are removed from the scope folder and its `.trash/`; links, folders and every other name
are never touched. Each scope is swept at most once per 10 minutes per process, so the first write
after a start cleans up.

## Evidence
- Code: `src-tauri/src/access.rs` (access without marker), `src-tauri/src/notes.rs` (`lock_scope`,
  `SCOPE_LOCK_FILE`, `SCOPE_LOCK_WAIT`, `Hold`, `create_free_file`), `src-tauri/src/watch.rs`,
  `src-tauri/src/windows.rs` (`notify_outside`), `src-tauri/src/lib.rs` (`watch_outside_changes`).
  Security review: `src-tauri/src/fsio.rs` (`open_lock_file`, `lock_file_matches`,
  `try_set_aside`, `is_atomic_temp_name`), `src-tauri/src/notes.rs` (`lock_scope_with`,
  `MetaRead::NotJson`, `set_aside_index`, `read_trash_locked`, `sweep_temps_in`).
- Tests, Windows 11, Rust stable, 2026-11-26: `hangars_folder_is_writable_without_a_marker`,
  `a_second_hangar_note_on_hangars_folder_stays_read_only`,
  `the_scope_lock_serialises_two_writers` (two stores, two threads, 31 notes, no entry lost; fails
  without the lock), `a_change_waits_for_hangars_lock_and_keeps_its_entry` (fails without the
  lock), `a_held_lock_ends_in_a_storage_error_after_the_wait`,
  `a_read_only_store_takes_no_scope_lock`, `a_write_with_a_stale_version_is_refused`,
  `a_write_returns_the_version_of_the_file_it_wrote`,
  `a_new_note_never_replaces_a_file_that_appeared`, `a_delete_moves_the_text_hangar_saved_last`,
  `hangars_changes_are_seen_and_own_changes_are_not`, and the tests of `watch.rs`.
- Amendments, tests, Windows 11, Rust stable, 2026-11-26: `fsio.rs`
  `a_rename_waits_for_a_target_held_open_for_a_moment` (target opened without
  `FILE_SHARE_DELETE` for 200 ms; the first plain rename fails, the write succeeds after it),
  `a_target_held_open_too_long_fails_and_leaves_no_temporary_file`,
  `hidden_and_temporary_names_are_no_notes` (the exact temporary name),
  `links_are_not_regular_files_or_folders`; `notes.rs` `the_version_is_the_hash_of_the_content`
  (same length, restored modification time: still `changed`),
  `a_note_write_waits_for_hangars_lock_and_sees_its_save`,
  `a_write_returns_the_version_of_the_file_it_wrote`, `a_held_lock_ends_in_a_storage_error_after_the_wait`,
  `unsafe_index_entries_are_skipped_and_never_followed`, `linked_note_files_are_never_followed`,
  `hidden_and_temporary_files_are_not_notes`, `broken_metadata_loses_no_notes`,
  `a_broken_trash_index_is_not_rewritten`, `unknown_fields_survive_a_rewrite`. File symlinks need a
  privilege on Windows that the test run did not have; those halves were skipped there and run on
  Unix, junctions were tested.
- Security review, tests, Windows 11, Rust stable, 2026-11-26: `notes.rs`
  `a_held_scope_lock_cannot_be_swapped_away` (Windows: delete and rename of the held `.lock` fail;
  fails with the default share mode; Unix: the deleted file is noticed and the lock is taken on the
  new one), `a_scope_lock_with_a_second_name_is_refused`, `a_linked_scope_lock_is_never_followed`
  (junction; the dangling file symlink half needs a privilege on Windows and was skipped there),
  `an_index_that_is_not_json_is_set_aside_and_the_scope_works_again`,
  `a_trash_index_that_is_not_json_is_set_aside`, `broken_metadata_loses_no_notes` and
  `a_broken_trash_index_is_not_rewritten` (valid JSON of unknown version or shape stays byte for
  byte), `stale_temporary_files_are_swept_and_nothing_else`,
  `stable_ids_match_the_shared_test_vector` (the three vectors of Hangar's ADR 0022),
  `a_rebuilt_index_holds_ids_both_apps_accept`; `service.rs`
  `colors_of_derived_ids_survive_a_rebuilt_index`; `fsio.rs`
  `lock_files_are_plain_and_checked_by_identity`, `only_exact_atomic_temp_names_match`,
  `a_set_aside_never_replaces_an_earlier_copy`. The Unix branches (`O_NOFOLLOW`, `lstat`
  identity, the retry after a deleted lock file) compile only there and were not run on this
  machine.

> [!question] Unverified
> The scope lock on a network share or a synced folder (OneDrive, Seafile) is only as reliable as
> the file system's lock support; Hangar's notes live in the local data folder, so this was not
> measured. Linux and macOS behavior of `flock` across two processes is taken from the standard
> library's documentation, not measured here.
