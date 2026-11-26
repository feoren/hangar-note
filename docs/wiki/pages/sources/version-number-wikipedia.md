---
title: "Wikipedia: Versionsnummer (version number)"
type: source
tags: [version, release]
sources: []
raw: raw/2026-11-26-versionsnummer-wikipedia.md
url: https://de.wikipedia.org/wiki/Versionsnummer
retrieved: 2026-11-26
created: 2026-11-26
updated: 2026-11-26
---

# Wikipedia: Versionsnummer

Summary of the German Wikipedia article "Versionsnummer", revision 267798157 of 2026-06-09. The
article is short, cites few sources and carries a redundancy banner (overlap with "Version
(Software)"), so it describes common practice, not a standard.

## Key points
- **Four parts:** major version (very significant change, a rewrite or a library that can no
  longer keep its interface compatible), minor version (mostly a functional extension), revision
  number (patch level, mostly bug fixes), build number (progress in single steps, e.g.
  `5.0.0-3242` is the 3242nd build). The worked example is `2.3.5-0041`.
- **Build number from version control:** with a version control system, a number that uniquely
  identifies the sources of the build inside it is often used instead of a counter, so the sources
  of a faulty build are easy to find.
- **Resetting:** when the major or minor version goes up, the following parts are reset to 0,
  except the build number. Many projects raise the build number independently and never reset it.
- **Several digits per part:** 0.9 is followed by 0.10, not 1.0.
- **Major version 0** is often an exception: larger changes are possible even when only the minor
  version goes up. Versions below 1.0 mean "not yet at the developers' goal", not necessarily
  "immature".
- **No fixed rules:** the meaning of each part is a quasi-standard. .NET, for example, uses
  `Major.Minor.Build.Revision`, with build and revision swapped compared to the scheme above, and
  separates `AssemblyVersion`, `AssemblyFileVersion` and `AssemblyInformationalVersion`.
- Also covered, not relevant here: date-based versions (`2024.10.12-0002`), marketing names and
  skipped numbers, stage suffixes (alpha, beta, RC, release, patch).

## Significance for Hangar Note
- Basis for [[0003-version-scheme]], which takes over Hangar's scheme `X.Y.Z-B`: the three
  semantic parts plus a build number that is the commit count of the built state, the "number that
  identifies the sources" the article describes, never reset.
- The article's `-` before the build number is a display convention. It collides with SemVer,
  where `-` starts a pre-release; the ADR resolves that with an internal `+` form (conclusion from
  the SemVer rules the ADR cites, not from this article).
- Hangar's wiki has a page of the same name, retrieved 2026-11-07 without a raw copy; this page is
  Hangar Note's own ingest with the raw text kept under `raw/`.
