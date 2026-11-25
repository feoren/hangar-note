---
title: LLM Wiki pattern (Karpathy)
type: source
tags: [wiki, knowledge-base, llm, tooling]
sources: []
raw: raw/2026-11-25-llm-wiki-pattern.md
url: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
retrieved: 2026-11-25
created: 2026-11-25
updated: 2026-11-25
---

# LLM Wiki pattern

Idea file by Andrej Karpathy (gist revision `ac46de1`). It describes a pattern, not an
implementation; the concrete layout of this wiki is set in the schema (`docs/wiki/CLAUDE.md`).

## Key points
- Instead of RAG over raw documents, the LLM builds and maintains a persistent, interlinked
  Markdown wiki between the human and the sources. Knowledge is compiled once and kept current.
- Three layers: immutable raw sources, LLM-written wiki pages, and a schema file (e.g. `CLAUDE.md`)
  that defines structure, conventions and workflows.
- Three operations: **ingest** (read a source, write a summary, update affected pages, index and
  log), **query** (read the index first, answer with citations, file good answers back as pages),
  **lint** (contradictions, stale claims, orphans, missing pages and cross-references, gaps).
- `index.md` is the content catalog, read first on every query; `log.md` is an append-only
  chronicle with a parseable prefix `## [YYYY-MM-DD] <op> | <title>`.
- Optional tooling: a local Markdown search engine (qmd) once the index no longer suffices;
  Obsidian as the viewer (graph view, Dataview over frontmatter, local attachments).

## Significance for Hangar Note
- The wiki under `docs/wiki/` follows this pattern, with the same layout as the Hangar wiki so that
  both can be read and linted the same way.
- No search tool for now: at this size `index.md` is enough (conclusion, not measured).
