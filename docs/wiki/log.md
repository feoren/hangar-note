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
