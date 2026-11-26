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
