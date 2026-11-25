# Hangar Note wiki: schema

Project wiki for Hangar Note, following the "LLM Wiki" pattern ([[llm-wiki-pattern]],
raw source `raw/2026-11-25-llm-wiki-pattern.md`).
The LLM writes and maintains the wiki. The human curates sources, asks questions and steers.
This file is the schema. Change it only after asking.

**Scope:** rules and way of working live in the root `CLAUDE.md`. The wiki holds knowledge and
evidence: how libraries, platforms and the note format actually behave, and why decisions were
made the way they were. Never duplicate a rule; refer to the root `CLAUDE.md` instead.

## Structure

```
raw/              Raw sources. IMMUTABLE: read only, never edit, never delete.
                  Doc excerpts, issues, changelogs, measurement records, logs, notes.
raw/assets/       Images and attachments belonging to the sources.
pages/            Pages written by the LLM.
  sources/        One summary per raw source.
  components/     Libraries, frameworks, OS APIs, services (Tauri, editors ...).
  platforms/      Windows, macOS, Linux (X11/Wayland): behavior, pitfalls, versions.
  concepts/       Terms and mechanisms (note format, sync, conflicts, encryption ...).
  decisions/      Decisions in ADR style, numbered: `0001-<name>.md`.
  syntheses/      Comparisons, analyses, filed answers to questions.
  overview.md     The big picture: state of knowledge, open risks, open questions.
index.md          Catalog of all pages (organized by content).
log.md            Chronicle of all operations (append-only).
```

## Page conventions

- File names: `kebab-case.md`, ASCII.
- Links: Obsidian wikilinks `[[name]]` or `[[name|display text]]`. References to code as a
  path relative to the project root, e.g. `src-tauri/src/lib.rs:42`.
- Every page starts with YAML frontmatter:

```yaml
---
title: Readable title
type: source | component | platform | concept | decision | synthesis | overview
tags: []
sources: []        # wikilinks to pages under sources/
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

- `source`: additionally `raw: raw/<file>`, `url`, `retrieved: YYYY-MM-DD`.
- `component`: additionally `version` (verified version), `license`, `repo`.
- `decision`: additionally `status: proposed | accepted | superseded`, `superseded_by`.
  Outline: Context, Options, Decision, Consequences, Evidence.
- **Verified vs. unverified:** every statement about APIs, versions or platform behavior carries
  a source `([[source-x]])` or is marked with `> [!question] Unverified`.
  File results you measured yourself as a source under `raw/` (command, platform, version, output).
- Never resolve contradictions silently: `> [!warning] Contradiction` plus both positions.
- Version-bound: always state the version for behavior that changes between versions.
- Language: English; identifiers in their original form.

## Workflows

### Ingest (process a new source)
1. Read the source in `raw/` in full. Save URLs to `raw/` as Markdown first
   (`raw/YYYY-MM-DD-<name>.md`).
2. Briefly name the key points and their relevance to Hangar Note.
3. Create `pages/sources/<name>.md`: summary, key points, significance for Hangar Note.
4. Create or update the affected pages. Check new data against existing statements.
5. If the source touches a decision, update the affected `decisions/` page or
   propose a new decision as `proposed`.
6. Update `pages/overview.md`, `index.md` and `log.md`.

### Query (answer a question)
1. Read `index.md` first, then the relevant pages.
2. Answer with references to wiki pages and sources.
3. File valuable answers as `pages/syntheses/<name>.md`.
4. If the wiki is not enough: say so clearly, propose sources or a measurement experiment.

### Lint (health check)
Report first, fix after approval:
- Contradictions, outdated statements (new versions), unverified statements without follow-up work.
- Orphans, broken `[[...]]` links, pages missing from the index, missing frontmatter.
- Decisions whose evidence has changed.
- Code references whose file or line no longer matches.
- Gaps: known platform pitfalls without an evidenced wiki page.

## index.md
Organized by category. One line per page: `- [[name]]: one-liner (sources: n, updated: YYYY-MM-DD)`

## log.md
Append-only. Every entry starts with `## [YYYY-MM-DD] <ingest|query|lint|schema> | <title>`,
followed by a few lines: what was done, which pages changed.
Latest entries: `grep "^## \[" log.md | tail -5`

## Rules
- Never modify `raw/`.
- Never invent facts; label conclusions as such.
- No secrets, tokens or API keys in the wiki, not even in logs under `raw/` (mask them first).
- Pages that stay local (listed in `.git/info/exclude`) are never linked from `index.md`, `log.md`
  or `overview.md`.
- Commits follow Conventional Commits: `docs(wiki): ingest <title>` and so on.
