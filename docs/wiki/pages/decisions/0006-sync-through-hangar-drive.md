---
title: "ADR 0006: Sync the notes through Hangar Drive"
type: decision
status: accepted
superseded_by:
tags: [sync, hangar-drive, ipc, contract, status, security]
sources: []
created: 2026-11-28
updated: 2026-11-28
---

# ADR 0006: Sync the notes through Hangar Drive

## Context
[[0001-foundation]] lists "sync between devices" as a non-goal, and the project profile repeats it
("beyond Git and the Hangar relay"). The sister app Hangar Drive syncs folders end to end encrypted
through the person's own server. Its contract "drive-local 1" (Hangar Drive repository, ADR 0003,
status proposed on 2026-11-28) lets Hangar Note ask Drive to sync Hangar's private notes folder and
tell, per note, whether Drive has synced it.

The owner decided on 2026-11-28:

1. **The folder stays where it is:** Hangar's notes folder `<local data>/com.feoren.hangar/notes`,
   which Hangar and Hangar Note write under "notes-shared 1" ([[0005-shared-notes-folder]]). Drive
   gets a narrow root exception for exactly this folder; nothing moves.
2. **Start after one confirmation in Drive:** Hangar Note sends `folders/request` by itself when
   Drive is installed and its notes state is `none`. Drive asks the person once on its own card.
   Hangar Note has no dialog of its own and no route to revoke; stopping happens only in Drive.
3. **The mark shows only `synced`,** with the text "Auf deinem Server", never "Auf allen Geräten":
   `synced` means the person's server accepted this version, not that every device has it.

## Options

| Option | Advantage | Disadvantage |
| --- | --- | --- |
| Keep the non-goal | nothing to build or review | the person syncs the notes folder by hand, or not at all |
| Sync of its own (relay, Git) | no second app | a second sync engine, crypto and conflict model next to Drive's |
| Sync through Hangar Drive (chosen) | one sync engine for the family, Drive's encryption and conflict rules, nothing moves | Drive becomes a third writer of the shared folder; the feature waits for Drive and for a Hangar release with the scope lock |

Within the chosen option, the transport choices (loopback HTTP with the hello proof, long poll
instead of server-sent events, no peer process check in version 1) are Drive's ADR 0003's; this
ADR takes them as they are.

## Decision
The non-goal "sync between devices" is lifted for exactly one path: Hangar Drive syncing Hangar's
notes folder in place, by contract "drive-local 1". Every other sync stays a non-goal.

### What Hangar Note does
- **Only Hangar's folder.** The client starts only when the notes root is Hangar's own folder
  (`access::RootKind::Hangar`). With the development root (`HANGAR_NOTE_NOTES_ROOT` in a debug
  build) it never starts and the phase stays `absent`: Drive computes and syncs only the canonical
  folder, so a status for another folder would be wrong.
- **Discovery** (`src-tauri/src/drive/discovery.rs`): `dirs::data_local_dir()/com.feoren.hangar-drive/`.
  `install.json` at most 16 KiB, `version` 1, `contracts["drive-local"]` lists 1; else Drive counts
  as absent. `endpoint.json` at most 4 KiB, `version` 1, a port that is not 0, a token of 64
  lowercase hex digits; else installed but not running. Both are read through
  `fsio::read_capped_wiped` (no link followed); unknown fields are ignored. `exe` is never run.
- **Exchange** (`src-tauri/src/drive/client.rs`, `src-tauri/src/channel/mod.rs` `exchange`):
  Hangar Note's own channel client, generalized rather than copied: a hello with a nonce and no
  token on a keep-alive connection, the proof checked in constant time with the key
  `SHA-256("hangar-drive-local-server" || token)` (`proof::key_with_label`), then exactly one
  request with the token and `Connection: close`, its answer proven over its own nonce and path.
  An unproven hello or answer is "Drive is not running"; nothing but the nonce reaches an unproven
  program. Answers are read up to 4 MiB. Routes take 10 s; `events` reads for `waitMs` plus 7 s.
- **Routes:** `status`; `folders/request` with profile `hangar-note-1`, once per endpoint while
  `notes.state` is `none`; `items/status` only while the notes are `active`, in batches of at most
  256, each note as `<scope>/<file>.md` relative to the notes folder with its version
  (`notes::content_version`, the SHA-256 of its bytes); only active notes, never `.trash`;
  `events` as a long poll from a `null` cursor with `waitMs` 25000: `items` asks for those paths
  again (a path of an unknown note lists its scope again), `reset` for every note, `status` for
  the status.
- **Answers are untrusted:** unknown fields are ignored; an unknown `reason` shows like none; an
  item state other than `synced` is no mark; every path of an answer passes the path rule
  (`src-tauri/src/drive/paths.rs`) and must be one that was asked for, else it is dropped; error
  codes are kept only in their documented form (lowercase letters and `-`); folder names lose
  control characters and are cut at 255 characters; cursors longer than 64 characters or not
  visible ASCII restart from `null`.
- **States as types** (`src-tauri/src/drive/state.rs`): the link (`Absent`, `NotRunning`,
  `Running(status)`) and Drive's account and notes states as enums; one pure function maps them to
  the phase. The account comes first: `notSetUp` is `setup`, `needsAttention` is `attention`.

  | Drive | Phase |
  | --- | --- |
  | no `install.json` with contract 1, or a development root | `absent` |
  | `install.json`, no valid endpoint, nothing listening, or no valid proof | `notRunning` |
  | account `notSetUp` | `setup` |
  | account `needsAttention` | `attention` |
  | `none` (Hangar Note asks at once), `requested` | `asked` |
  | `waitingForFolder` | `waiting`, with `reason` |
  | `active` | `active`, with `folderName` and `lastSyncMs` |
  | `unavailable` | `unavailable`, with `reason` |
  | `declined` | `declined` |

- **Worker** (`src-tauri/src/drive/worker.rs`): one thread finds Drive every 10 s while it is
  absent or not running, reads the status, asks once, and runs the `items/status` rounds; one
  thread holds the `events` long poll. Every file the store writes (`watch::OwnObserver`, set on
  the store) and every scope the watcher reports collect for 1.5 s, at most 5 s after the first,
  then the affected notes are asked for again: a saved note by its path, a changed index by its
  scope. A note's version is read again only when its file state changed. Failures back off from
  2 s to 60 s; a proven refusal or an unproven answer counts as not running, a busy (also a proven
  `503 busy`) or cut connection keeps the last state. Quitting cuts the wait for an answer short
  within 100 ms (`channel::StreamSlot`, waits in 100 ms steps instead of relying on a shutdown
  from another thread to wake a blocked read, which on Windows 11 it did not in the stop test); a
  hello in progress ends at the latest after its 5 s deadline. Then both threads are joined. No
  window thread ever waits for Drive.
- **Hardening after the security review of 2026-11-28** (verdict: fit for release, follow-ups
  done): every `events` round lasts at least 250 ms whatever the answer, and `reset` answers in a
  row double the pause up to 30 s, so a Drive that always resets (also with a cursor that never
  validates) cannot make the long poll or the full rounds spin (N1); the hello and the request are
  each read against one total deadline (`slots::Deadline`), so a server trickling one byte at a
  time cannot stretch them, and a cancel is checked between hello and request (N2);
  `StreamSlot::hold` checks the cancel again after storing its handle and refuses when the handle
  cannot be made (N3); `endpoint.json` is read into one wiped buffer of fixed size
  (`fsio::read_capped_wiped`, also for Hangar Note's own `endpoint.json`) (H1); `Endpoint` and
  `Found` have no derived `PartialEq`, so a token is never compared by `==` (H2).
- **Interface to the windows:** the command `drive_sync_status` returns a `DriveSyncView`, the event
  `drive-sync-changed` carries the same view and is sent only when it changed:

  ```json
  { "phase": "active", "folderName": "Hangar Note", "lastSyncMs": 1764240000000,
    "synced": { "general": ["<note id>"], "<32 hex>": ["<note id>"] } }
  ```

  `phase` is one of `absent`, `notRunning`, `setup`, `waiting`, `asked`, `active`, `unavailable`,
  `declined`, `attention`; `reason` (`missing`, `refused`, `hangarTooOld`), `folderName` and
  `lastSyncMs` are left out when they have no value; `synced` is empty unless the phase is `active`.
  Both window capabilities (`hub`, `note`) may call the command. That every sticky note window
  sees the folder keys and note IDs of all synced notes is accepted on purpose (decided
  2026-11-28): the command only reads, it carries IDs without content or titles, all windows run
  in the same process and trust domain, and a filter per window would need the window's identity
  in the command while giving no real protection.

### What Hangar Note never does
- send a path to sync, a note's content or a hash other than the note's own version in
  `items/status`;
- start Drive, run its `exe`, or show a consent dialog of its own;
- revoke or stop the sync (no such route exists);
- log the token, a nonce or an answer body.

## Consequences
- The notes sync on every device whose person agrees once in Drive on that device.
- Drive is a third writer of the shared folder: [[0005-shared-notes-folder]] gains the additions of
  Drive's ADR 0003, section 10 (amendment of 2026-11-28). The feature waits for a Hangar release
  that takes the scope lock; until then Drive reports `hangarTooOld` and Hangar Note shows
  `waiting` or `unavailable`.
- A note larger than 1 MiB, or a file the index does not name yet, is not asked for and shows no
  mark. A `.md` file Drive brings in appears once Hangar Note or Hangar adopt it into the index;
  that index write is an own write and asks for the scope again.
- The mark can lag a save by the debounce (about 1.5 s) plus Drive's answer; it can show `synced`
  for an instant after a save until the round for the new version answers `pending`.
- Hangar Note's `is_folder_key` accepts upper case hex digits, Drive's profile only lower case.
  Neither app ever creates such a folder (`folder_key` writes lower case); a foreign one stays
  local in Drive and gets no mark here.
- Two threads and two short loopback connections per round while Drive runs; none while it does
  not.

## Deviations from the contract, with reasons
- **`none` shows as `asked`:** Hangar Note asks at once, so `none` lasts only until its request
  lands; a separate phase would flash for a moment.
- **Unknown `account` is `attention`, unknown `notes.state` is `unavailable`:** a new value is a
  breaking change under section 9 and would come with version 2; showing it as a problem is safer
  than guessing `active`.
- **More than 1024 paths in one `events` answer count as `reset`:** Drive sends `reset` beyond 256
  anyway; the cap bounds the work on a misbehaving server.
- **`events` reads for `waitMs` plus 7 s,** above the 5 s minimum, so a busy Drive that answers
  late is not counted as gone.

## Evidence
- Hangar Drive repository, ADR 0003 "Local app contract drive-local 1", read on 2026-11-28
  (sections 1 to 3, 8 to 10, implementation steps for Hangar Note).
- Code: `src-tauri/src/drive/` (`discovery.rs`, `client.rs`, `paths.rs`, `state.rs`, `worker.rs`,
  `tests.rs`), `src-tauri/src/channel/mod.rs` (`exchange`, `Peer`, `StreamSlot`,
  `wait_for_answer`), `src-tauri/src/channel/proof.rs` (`key_with_label`),
  `src-tauri/src/notes.rs` (`note_files`, `observe_own_writes`), `src-tauri/src/watch.rs`
  (`OwnObserver`), `src-tauri/src/lib.rs` (`start_drive_sync`), `src-tauri/src/commands.rs`
  (`drive_sync_status`), `src-tauri/src/windows.rs` (`DRIVE_SYNC_CHANGED_EVENT`).
- Drive's folder is computed from `app.path().local_data_dir()`: in tauri 2.12.7
  (`src/path/desktop.rs`, `local_data_dir`) that is `dirs::data_local_dir()`, and tauri depends on
  `dirs` 7.0.0, the version Hangar Note and Drive use (code reading and `Cargo.lock`, 2026-11-28).
- Known answers computed with Python's `hashlib` and `hmac` and pinned in `client.rs`
  (`the_drive_proof_matches_pinned_vectors`): token `0123456789abcdef` × 4, nonce
  `fedcba9876543210` × 4, key
  `e3afae7af3b9bc2f02809a0e76cb7b7de442ce3af940f3cdbee0215e8d9465d5`; `/v1/hello`, 200,
  `{"version":1}` give `53801ead49349d55ba6171b890c26b1031d72efd32a740940904161b902b0432`;
  `/v1/items/status`, 409, `{"version":1,"error":"not-active"}` give
  `c01676a5a5f08cd589a43007c846e88817649c0657a96bb16dc3aebd7e917a20`. Hangar Drive should pin the
  same vectors.
- Tests, Windows 11, Rust stable, 2026-11-28, against a fake Drive on 127.0.0.1 with real sockets:
  `a_running_drive_is_asked_once_and_synced_notes_are_marked` (one request with the profile, every
  note with its SHA-256, unknown fields everywhere, invalid and unasked paths dropped),
  `a_wrong_proof_means_drive_is_not_running_and_gets_no_token`,
  `installed_without_endpoint_is_not_running_and_without_install_absent`,
  `unknown_reasons_show_like_none`, `a_reset_asks_for_every_note_and_items_for_those_paths`,
  `many_notes_are_asked_for_in_batches_of_256` (256, 256, 88),
  `an_own_save_asks_for_that_note_with_its_new_version`, `stopping_cuts_the_long_poll_short`
  (stop within 3 s during a 25 s wait; it took 25 s before `wait_for_answer`),
  `the_store_lists_active_notes_and_skips_drives_marker_folder`,
  `a_drive_that_always_resets_is_slowed_down`, `an_unproven_error_answer_is_unconfirmed_not_refused`
  (409 without or with a wrong proof is `Unconfirmed`, proven it is the refusal),
  `a_proof_for_another_route_fails` (a proof for `/v1/status` on `/v1/items/status`),
  `a_trickling_answer_ends_after_the_total_time` (one byte per 100 ms, total 1 s),
  `busy_and_cut_connections_are_transient_and_refusals_are_not`;
  `channel` `a_cancelled_slot_holds_nothing`, `fsio` `a_secret_file_is_read_into_one_buffer_and_capped`,
  `worker` `rounds_last_at_least_the_minimum_and_resets_in_a_row_slow_down`; pure tests of the path rule
  (1024 bytes, 16 components, `..`, `\`, control characters, UNC and drive prefixes), the
  discovery limits and fields, the phase mapping and the view's JSON shape.

> [!question] Unverified
> - Behavior against the real Hangar Drive server: it did not exist yet; everything was tested
>   against the fake, built from the contract text.
> - That a shutdown from another thread does not wake a blocked read on Windows was observed once
>   in the stop test (25 s on Windows 11), not taken from Winsock's documentation; the client no
>   longer depends on it either way. Unix was not run.
