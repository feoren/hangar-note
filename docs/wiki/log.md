# Log

Append-only chronicle. Format: `## [YYYY-MM-DD] <ingest|query|lint|schema> | <title>`

## [2026-11-25] schema | Wiki created
Structure set up following the LLM Wiki pattern (Karpathy): raw/, raw/assets/,
pages/{sources,components,platforms,concepts,decisions,syntheses}, overview.md, index.md, log.md,
CLAUDE.md (schema, modeled on the Hangar wiki).

## [2026-11-25] ingest | LLM Wiki pattern
Saved the gist as raw/2026-11-25-llm-wiki-pattern.md and created pages/sources/llm-wiki-pattern.md
and pages/overview.md. Index updated.

## [2026-11-25] schema | ADR 0001 foundation
Created pages/decisions/0001-foundation.md (accepted): sticky notes on the desktop, window model,
storage, editor, colors, code layout, non-goals. Updated index.md and pages/overview.md.

## [2026-11-26] schema | ADR 0002 takeover of Hangar's notes
Created pages/decisions/0002-hangar-notes-takeover.md (accepted, storage in place by the owner's
choice). Marked the non-goals of pages/decisions/0001-foundation.md as superseded in part. Updated
index.md and pages/overview.md.

## [2026-11-26] schema | ADR 0002 handover marker
Added the handover marker `notes/.handover.json` (read only until Hangar writes it) and the
development root `HANGAR_NOTE_NOTES_ROOT` to pages/decisions/0002-hangar-notes-takeover.md.

## [2026-11-26] schema | Phase 1 of ADR 0002 as built
Added the section "Phase 1 as built" to pages/decisions/0002-hangar-notes-takeover.md (deviations
with reasons). Created pages/concepts/hangar-notes-format.md and pages/syntheses/local-channel.md.
Noted in pages/decisions/0001-foundation.md that its own storage is replaced. Updated index.md and
pages/overview.md.

## [2026-11-26] schema | ADR 0002 channel proof and hardening
Added the server proof (`/v1/hello`, HMAC over nonce, status and body) and the shared hardening
rules to the local channel section of pages/decisions/0002-hangar-notes-takeover.md, after the
security review of phase 1.

## [2026-11-26] query | Usability pass of the notes area
Created pages/syntheses/usability-pass.md (review findings and own findings with change and
reason). Updated index.md.

## [2026-11-26] schema | Phase 1 hardening after the security and acceptance reviews
Extended "Phase 1 as built" in pages/decisions/0002-hangar-notes-takeover.md: ADR 0001's store
given up without a migration, CRLF to LF on saving, debug starts rewriting `install.json`, and the
hardening (server proof, connection slots, owner-only `endpoint.json`, `SO_EXCLUSIVEADDRUSE`,
`Zeroizing`, 415, navigation filter, capture exit codes and guard, stable IDs, no links followed,
development root check, "Always on top" of the notes area). Rewrote
pages/syntheses/local-channel.md for the new contract (proof, exit codes, checks, slots).

## [2026-11-26] update | Leaving an unsaved note, copying through the backend
Added "Leaving an unsaved note" to pages/decisions/0001-foundation.md (refused first with "Copy as
Markdown", a second try within 10 s leaves, as "Quit" does) and the backend command `copy_text`.
Moved both open items of pages/syntheses/usability-pass.md to "Resolved after the pass".

## [2026-11-26] schema | ADR 0002 team operations instead of the ring
Replaced `team/ring` by the operations `team/open` and `team/seal`, so the notes key ring never
leaves Hangar; added the integrity label, one connection per exchange, a separate team token and
fixed storage error codes, after the second security review.

## [2026-11-26] update | Channel after the second security review
Added to the section "Phase 1 as built" of pages/decisions/0002-hangar-notes-takeover.md how the
integrity label, one connection per exchange, the slot release before answering, the team token
and the storage codes (now with `not-found`) were built. Updated pages/syntheses/local-channel.md:
`teamToken`, scopes, keep-alive after the hello, grace and linger times, a table of the storage
codes per platform, new verified tests and the manual `icacls` check.

## [2026-11-26] ingest | Wikipedia: Versionsnummer
Saved the German Wikipedia article "Versionsnummer" (revision 267798157) as
raw/2026-11-26-versionsnummer-wikipedia.md and created pages/sources/version-number-wikipedia.md.
Created pages/decisions/0003-version-scheme.md (accepted): Hangar's scheme `X.Y.Z-B`, internal
`X.Y.Z+B`, build number set only when building, no `buildNumberBase`, the code carries the
upcoming version, `src/changelog.json` in 12 languages, `src/versionSync.test.ts`, the rules for
the release script. Updated index.md and pages/overview.md.

## [2026-11-26] schema | ADR 0002 conditions for team operations
Recorded the five conditions agreed with Hangar for `team/open` and `team/seal` (verdict with the
plaintext, exact write rule without fallback, size and rate limits, known vaults only, separate
token on one connection) in pages/decisions/0002-hangar-notes-takeover.md.

## [2026-11-26] query | Direction A as built
Added the section "Direction A as built" to pages/syntheses/usability-pass.md: title menu, color
filter behind one button, row tools and row context menu, the note as a page, one notice place in
the footer (src/notices.ts), error sentences per code (src/errors.ts), the calm sticky note with its
drag strip, the motion table. Recorded the changed windows in pages/decisions/0001-foundation.md.

## [2026-11-26] query | Review of direction A
Recorded three fixes from the review of the build (row meta under the tools, notices at 320 px,
slim scrollbars) in pages/syntheses/usability-pass.md.

## [2026-11-26] schema | ADR 0004 switchable looks
Created pages/decisions/0004-switchable-looks.md (accepted): the owner asked for all three design
directions to be built in, as one setting over one shared notes area. Index updated.

## [2026-11-26] query | Rework of direction A, looks B and C as built
Added the sections "Rework of direction A" (single title, short warning, focus after back and after
a notice, the note on the desktop named, new notes listed at once, trash rows like list rows,
project names only in All) and "Looks B and C as built" (one logic in `src/useNotesArea.tsx`, three
layouts, the look setting, paper's cards and sheet, hangar's three columns and status bar, the
sticky note per look, contrast per surface, the check in the real window) to
pages/syntheses/usability-pass.md. Index entry updated.

## [2026-11-26] query | Acceptance review of looks B and C
Added what the acceptance review found and fixed in the real window (a tick on a card racing the
opening of its note, the paper scopes breaking into a column, the hangar note header overflowing
between 760 and about 1000 px, the sheet's focus trap) to pages/syntheses/usability-pass.md.

## [2026-11-26] query | Rework of looks B and C
Added the section "Rework of looks B and C" (the card fade only on overflow, the hangar progress
shown once, the trash per look with Escape back, grid keys by column, the sticky window titled
after its note) to pages/syntheses/usability-pass.md.

## [2026-11-26] query | Backend fixes of the complete security review
Recorded the backend findings B1 to B10 as built: the capture written by the backend before the
channel answers, the atomic editor rule, log lines without titles or paths, fixed error codes for
every error, wiped head buffers, the tray texts from the notes area, invisible characters out of
sticky window titles, note versions against changes from outside, the license allowlist. Updated
pages/syntheses/local-channel.md (capture, memory of tokens, log), the "Phase 1 as built" section of
pages/decisions/0002-hangar-notes-takeover.md, and added "Updater rules for the first release" to
pages/decisions/0003-version-scheme.md.

## [2026-11-26] query | Content Security Policy and the style nonce
Added the section "Content Security Policy" to pages/decisions/0001-foundation.md: the policy of
finding F1, why CodeMirror's style elements carry Tauri's per-load style nonce instead of
`'unsafe-inline'`, with the places in Tauri 2.12.7 (`src/manager/mod.rs`, `set_csp`,
`replace_csp_nonce`, `get_asset`) and style-mod 4.1.5 that show it, and why the dev server shows
no policy.

## [2026-11-26] query | Quiet refusal of a sticky note's menu texts
Added to B6 in the "Phase 1 as built" section of pages/decisions/0002-hangar-notes-takeover.md: a
sticky note whose menu texts are refused gets `not-allowed` without a log line
(`AppError::LabelsKept`); refusals of other windows are still logged.

## [2026-11-26] query | Proof binds the path; findings L1 to L4
Contract 1 changed before it was frozen (agreed with Hangar): the server proof is now
`HMAC(key, nonce || path || status || body)`, path as sent and routed on. Updated the "Server proof"
section of pages/syntheses/local-channel.md (with the new known answer) and the "Local channel"
section of pages/decisions/0002-hangar-notes-takeover.md. Also from the same review: `capture` counts
only a proven answer with `"ok": true` (L1); notes, export and sticky titles share one naming rule
in `naming.rs`, which drops invisible characters but keeps joiners and variation selectors inside
emoji sequences and Persian or Indic spelling (L2); renames, deletes and restores never replace a file (`fsio::rename_no_replace`, L3); request
and answer bodies land in one wiped buffer of their exact length (L4).

## [2026-11-26] update | B3 log scope confirmed by Hangar
Hangar writes no log file and will start Hangar Note with null stdio, so no Hangar path keeps
Hangar Note's log lines; noted under B3 in pages/decisions/0002-hangar-notes-takeover.md.

## [2026-11-26] update | Shared notes folder, contract "notes-shared 1"
Owner decision: Hangar and Hangar Note both write Hangar's private notes, at once and without a
handover. Added pages/decisions/0005-shared-notes-folder.md (options, the scope lock
`<scope>/.lock`, version checks, the one-second poll, residual risk until Hangar adopts it). Marked
the single writer, the handover marker and the read-only phase in
pages/decisions/0002-hangar-notes-takeover.md as superseded (text kept). Updated
pages/concepts/hangar-notes-format.md (layout, two writers), pages/overview.md,
pages/syntheses/local-channel.md (exit code 3) and index.md.

## [2026-11-26] update | Navigation rework of the notes area
Added the section "Navigation rework" to pages/syntheses/usability-pass.md: one sidebar in every
look (areas with counts, projects by folder name, colors, trash, settings), arrow keys and
Ctrl+1 to Ctrl+9, the folded sidebar below 760 px, the start on "All notes", guiding empty areas,
the "Read only" chip in place of the banner, and following changes outside without a click. Noted
the new widths in pages/decisions/0004-switchable-looks.md.

## [2026-11-26] update | Contract "notes-shared 1" adopted with amendments
Hangar and the owner adopted the contract with amendments; implemented on Hangar Note's side.
Added the section "Amendments" to pages/decisions/0005-shared-notes-folder.md: atomic writes retry
the rename on Windows for at most 1 s while the target is held open, never in place, temp files
`.<name>.<pid>.<n>.tmp` removed on failure and skipped with every dotfile and `*.tmp` by lister and
watcher (2); the note version is the SHA-256 of the content, checked and written under the scope
lock (3); untrusted index entries skipped, links and reparse points never followed, broken index
files never rewritten, unknown fields kept on every rewrite. Updated
pages/concepts/hangar-notes-format.md, the note on unknown fields in
pages/decisions/0002-hangar-notes-takeover.md and index.md.

## [2026-11-26] update | Levels and a sidebar that folds away
Added the section "Levels and a sidebar that folds away" to pages/syntheses/usability-pass.md:
the level tabs Private, Project (Hangar's project, switchable, stored as lastProject) and Team (an
empty state until Hangar is connected), the sidebar folded away with its button or Ctrl+Shift+S
and resized on its edge (sidebarOpen, sidebarWidth in settings.json), "New note" per level and the
start level. Noted the new hangar-look width rule in pages/decisions/0004-switchable-looks.md.

## [2026-11-26] update | Security review of contract "notes-shared 1"
Implemented Hangar's security review on Hangar Note's side. Added "2026-11-26: security review of
the contract" to the amendments of pages/decisions/0005-shared-notes-folder.md: the scope lock is
opened without FILE_SHARE_DELETE and without following links (also while creating it), checked by
file identity after locking and retried within the 2 s wait (L1), refused with more than one name
(L2); valid JSON of unknown version or shape stays byte for byte, only non-JSON folder.json and
trash.json are set aside as `<name>.broken-<millis>` without replacing an existing copy; stale
`.<name>.<pid>.<n>.tmp` files older than 10 minutes are swept when a scope is opened for writing.
Pinned the stable_id test vector of Hangar's ADR 0022 (identical derivation, nothing differed) and
noted that colors of notes whose random IDs only a lost index knew are not salvaged.
Updated pages/concepts/hangar-notes-format.md and index.md.

## [2026-11-27] update | Colors as a category list, Hangar's header and a clean notes area
Added the section "Colors as a category list, Hangar's header and a clean notes area" to
pages/syntheses/usability-pass.md: the sidebar's colors as rows with swatch, name and count (counts
of the shown list; per-scope counts would need a backend command), show all, a folding section,
rename in place; Hangar's header with the app menu (File, Edit, View, Help), logo, version and beta
badge; the levels inside the sidebar; no bars above or below the notes, notices as a floating
toast, a floating button for the folded sidebar.

## [2026-11-27] update | Security review of the shared notes folder
Added the amendment "2026-11-27: security review of the shared folder" to
pages/decisions/0005-shared-notes-folder.md: cleaned titles, 5000 entries and a byte budget per
index, reads without the scope lock, migration under the lock, hardened `.writer.lock`, bounded
listings, duplicate entries dropped, shortened arguments in the log. Updated index.md.

## [2026-11-27] update | Look switch, a calmer sidebar and widths that follow the window
Added the section "Look switch, a calmer sidebar and widths that follow the window" to
pages/syntheses/usability-pass.md: a look switch at the top right of the notes in every look, the
calm note bar always visible, list, page, search, cards, sheet, trash and settings widths that
follow the window, the sidebar's "Project folders" section, uniform headings and rows, level tabs
with marks, a default sidebar width of 248 px.

## [2026-11-27] update | "Calm" removed, paper opens a note only by choice
Added the amendment "2026-11-27: Calm removed, paper opens a note only by choice" to
pages/decisions/0004-switchable-looks.md (two looks, default hangar, a stored "calm" reads as
hangar, hangar's narrow layout, one drag header on the sticky note, the paper sheet rule) and the
section "Two looks and a paper sheet only by choice" to pages/syntheses/usability-pass.md. Updated
index.md.

## [2026-11-27] update | Sidebar footer, round fold button, one head line, tinted rows
Added the section "Sidebar footer, round fold button and one head line" to
pages/syntheses/usability-pass.md: icon footer with a light and dark switch, Hangar's round fold
button on the head line's crossing, the head line through every column, the chosen row in its
note's color. Updated index.md.

## [2026-11-27] update | Status line under the note
Added the section "Status line under the note" to pages/syntheses/usability-pass.md: line,
column, selection and character count in a thin line in the note's color below the notes area's
page and the sticky note, counted as grapheme clusters, reported by the editor's `onCursor`.
Updated index.md.

## [2026-11-27] update | Status line review
Updated the section "Status line under the note" in pages/syntheses/usability-pass.md: the notes
area's status line takes the sidebar footer's height (`--foot-height`), counts use singular and
plural pairs (`pluralKey`), notices float above the status line.

## [2026-11-27] query | Release process
Added pages/syntheses/release-process.md: the release script `tools/release.py` (build with
`--version`, publish on Forgejo first and on GitHub later, `--next`), the safety rules taken from
Hangar, the rules for two targets and unsigned builds. Added the addendum of 2026-11-27 to
pages/decisions/0003-version-scheme.md (installer name with a hyphen, no `latest.json` while
there is no updater, English release notes, unsigned only with `--allow-unsigned`). Updated
index.md.

## [2026-11-27] update | Note list width
Added the section "Note list width" to pages/syntheses/usability-pass.md: the note list's edge is
a separator like the sidebar's (one component, one width logic in `src/columnWidth.ts`), 240 to
640 px, the note keeps 328 px, `listWidth` in settings.json is `null` while the list follows the
window; the edges' accent line now lies on the border.

## [2026-11-27] update | Paper's search and "+" as in Hangar
Added the section on paper's search and "+" to pages/syntheses/usability-pass.md:
paper's top row uses Hangar's search field and "+" (32 px field, 34 px button), the field up to
420 px, and the field's border shows the focus in both looks.

## [2026-11-28] update | Sync through Hangar Drive
Added pages/decisions/0006-sync-through-hangar-drive.md: Hangar Note's side of contract
"drive-local 1" (owner decisions, client, phases, worker, the window interface, deviations, pinned
proof vectors, tests against a fake Drive). Added the amendment of 2026-11-28 to
pages/decisions/0005-shared-notes-folder.md (Drive as a third writer, section 10 of Drive's
ADR 0003, checked in the code) and a pointer in pages/decisions/0001-foundation.md. Updated
index.md.

## [2026-11-28] update | Drive client security follow-ups
Added the hardening after the security review (N1 to N3, H1, H2), the new tests and the check of
tauri's `local_data_dir` to pages/decisions/0006-sync-through-hangar-drive.md; softened the
statement about shutdown on Windows.

## [2026-11-28] update | Drive client review fixes
Corrected pages/decisions/0006-sync-through-hangar-drive.md after the acceptance review: both of
Drive's files are read through `fsio::read_capped_wiped`; a proven `503 busy` keeps the last state
like a busy hello; quitting cuts a wait for an answer short within 100 ms, a hello within its 5 s
deadline.

## [2026-11-28] update | Drive status in every window, cancellable hello
pages/decisions/0006-sync-through-hangar-drive.md: recorded that every window may read the IDs
of all synced notes through `drive_sync_status`, and why; the hello of a Drive exchange is now
cancellable as well, so quitting does not wait for a port holder that never answers.

## [2026-11-28] update | README screenshots
pages/syntheses/release-process.md: added the README screenshot step (`pnpm readme:shots`,
`tools/readme-shots/`) and the list of the seven current scenes, and why the images are not
rendered again after the build. Updated index.md.
