---
title: "ADR 0003: Version scheme Major.Minor.Revision-Build"
type: decision
status: accepted
superseded_by:
tags: [release, version, changelog, updater, windows]
sources: ["[[version-number-wikipedia]]"]
created: 2026-11-26
updated: 2026-11-27
---

# ADR 0003: Version scheme Major.Minor.Revision-Build

## Context
The owner decided on 2026-11-26 that Hangar Note uses Hangar's version scheme (Hangar's ADR 0002,
"Version scheme"): `N.N.N-NNNN`, read as major, minor, revision and build number, following
[[version-number-wikipedia]]. Hangar Note has no release yet; `tauri.conf.json`, `package.json` and
`Cargo.toml` carry `0.1.0`, there is no changelog and no release script.

What the scheme has to fit, as Hangar found it:
- The Tauri updater compares versions by SemVer. In SemVer `0.1.0-14` is a pre-release that sorts
  before `0.1.0`, and build metadata after `+` is ignored when comparing.
- Tauri's NSIS bundler derives the four-part Windows file version (`VIProductVersion`) from the
  SemVer build metadata: `0.1.0+14` becomes `0.1.0.14`; anything else after the patch number gives
  `0.1.0.0`. Read in `try_add_numeric_build_number`,
  `crates/tauri-bundler/src/bundle/windows/nsis/mod.rs` at the tag `tauri-cli-v2.12.6`, the CLI
  version in this repository's lock file, on 2026-11-26.

> [!question] Unverified
> The updater's comparison and the NSIS conversion are Hangar's evidence plus a reading of the
> bundler code; Hangar Note has neither built an installer nor added the updater yet. File both as
> sources with the first release build (installer properties, `latest.json` against an older
> install).

## Options
1. **SemVer pre-release internally (`X.Y.Z-B`).** Rejected: every build would sort before its own
   release, and the Windows file version would end in `.0`.
2. **No build number, only `X.Y.Z`.** Rejected: the owner wants the build number, and without it a
   build cannot be traced to its source state.
3. **Build number only outside the version** (an extra field, the Windows resources). Rejected:
   Tauri takes the Windows file version from the version itself, so a second place would drift.
4. **`X.Y.Z+B` internally, `X.Y.Z-B` displayed** (Hangar's way). Chosen.

## Decision
- **Parts.** X for fundamental or incompatible changes; while X is 0, Y may also jump further
  ([[version-number-wikipedia]]: major version 0 allows larger changes in the minor version). Y for
  new features, Z for bug fixes. When X or Y goes up, the parts after it go back to 0, never B.
- **Every release raises X, Y or Z.** The updater ignores build metadata, so a release that
  differs only in B would not be offered as an update.
- **Internal form** in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (with `Cargo.lock`),
  `package.json` and `latest.json` (no updater yet, see the addendum): `X.Y.Z+B`, e.g. `0.1.0+14`. NSIS turns it into the Windows
  file version `0.1.0.14`.
- **Displayed form** and file names: `X.Y.Z-B`, e.g. `0.1.0-14` and
  `Hangar Note_0.1.0-14_x64-setup.exe` (file name pattern as Hangar's, to be confirmed with the
  first build; published as `Hangar-Note_0.1.0-14_x64-setup.exe`, see the addendum). A `+` breaks download URLs, because forms and query strings read it as a space.
- **The build number is set only when building, as in Hangar.** Between releases the files carry
  `X.Y.Z` without B. The release script writes `X.Y.Z+B` into the files right before the build, the
  release commit keeps that state, and the step "next version" afterwards sets the files to the
  following `X.Y.Z` again.
- **B is the number of commits of the built state**, `git rev-list --count HEAD`, never reset. It
  identifies the source state ([[version-number-wikipedia]]: "a number that uniquely identifies
  the sources"); the commit of build B is `git rev-list --reverse HEAD | sed -n <B>p` on `main`.
- **No base, no `buildNumberBase` field (deviation from Hangar).** Hangar adds `buildNumberBase`
  (84) because its public repository began with a fresh history and the counts would otherwise
  have gone down. Hangar Note's history starts with its first commit and is the published one, so
  the base would be 0. Leaving the field out keeps `package.json` free of a value with no meaning;
  the release script treats a missing field as 0, as Hangar's `build_number_from` does. Should the
  history ever be replaced, the field comes in then, holding the old count.
- **The code always carries the upcoming version.** It is the highest entry of `src/changelog.json`
  and has `"date": null` there until the release. Today that is `0.1.0`.
- **Changelog `src/changelog.json`**, Hangar's format: a list, newest first, of
  `{ version: "X.Y.Z", date: "YYYY-MM-DD" | null, items: [{ de, en, el, es, fr, it, ja, pl, pt,
  ru, tr, zh }] }`. Only the topmost entry may be undated; only that entry may have no items yet
  (the state right after "next version"). Items are short sentences for users (at most 160
  characters, no en or em dash); German uses "du". Unlike Hangar, whose parser requires `de` and
  `en` and lets a test demand the rest, every item needs all 12 UI languages and no others.
  Where the app shows the changelog ("What's new") is decided with the redesign of the look.
- **One test keeps it consistent:** `src/versionSync.test.ts` (details under Consequences).
- **Release script (built with the first release, modeled on Hangar's `tools/release.py`):**
  - builds only from a clean working tree (`git status --porcelain` empty, untracked files
    included), so B names exactly the committed state. Unlike Hangar there is no `--allow-dirty`
    for a release that gets published; a local trial build uses `pnpm tauri build` instead.
    Hangar's check for build inputs Git does not see (Tauri config overrides, Cargo configs,
    toolchain files, `.npmrc`) comes along;
  - takes `--version X.Y.Z` and refuses a version that is not the highest changelog entry, is lower
    than the files, or is not higher than the last release (the highest dated changelog entry or a
    folder under `release/`);
  - dates the changelog entry, writes `X.Y.Z+B` into the four files, builds, signs, and writes
    `latest.json` with `X.Y.Z+B` and the German items as notes (no updater yet: no `latest.json`,
    see the addendum);
  - offers `--next X.Y.Z`: files to the new version without B, a new empty, undated changelog entry
    on top, refused while the current top entry is not released.

## Consequences
- `src/versionSync.test.ts` (Vitest, reads the files as text) requires:
  - the same version string in `tauri.conf.json`, `package.json`, `Cargo.toml` (`[package]`) and
    the `hangar-note` package in `Cargo.lock`, in the form `X.Y.Z` or `X.Y.Z+B`;
  - its `X.Y.Z` to be the topmost and highest entry of the changelog;
  - every changelog entry to have `X.Y.Z`, a valid date or `null`, versions strictly descending
    (no version twice), `null` only on the topmost entry, and every item all 12 languages with
    non-empty, trimmed texts of at most 160 characters without en or em dash.
  The same file checks the checker with broken examples, so a check that silently passes fails.
  `latest.json` does not exist before the first release; the script writes it from the same
  version (no updater yet: the script as built writes none, see the addendum).
- In release builds `install.json` carries `appVersion` in the internal form `X.Y.Z+B`
  (`env!("CARGO_PKG_VERSION")`, `src-tauri/src/install.rs`). Hangar reads that field; whoever
  shows it converts `+` to `-`.
- No version is shown in the app yet. Hangar shows the build number in development builds too
  (`vite.config.ts` defines `__HANGAR_BUILD__`, `withBuild` in `src/version.ts`); Hangar Note adds
  that together with the first place that shows a version.
- The Windows file version holds 16 bits per part, so B works up to 65535 commits.
  > [!question] Unverified
  > The 16-bit limit per part of the Windows version resource, from general knowledge of
  > `VS_FIXEDFILEINFO`; not looked up or measured here.

## Updater rules for the first release
Recorded after the complete security review (finding B10), before the updater is added. The
updater ships code onto the person's computer, so these hold from its first build on:
- **Signed updates only.** Every installer and update archive is signed with the updater key;
  the app refuses an update without a valid signature (Tauri updater with `pubkey` set, never
  without one).
- **The public key lives in `src-tauri/tauri.conf.json` only** (`plugins.updater.pubkey`), not in
  code, a script or an environment variable the build reads.
- **The private key is never in the repository and never in a synced folder** (no cloud or
  file sync folder, no backup that syncs it in plain text). It stays on the release machine, with
  its password kept apart from it; the release script reads both at build time only.
- **HTTPS endpoints only.** Every entry of `plugins.updater.endpoints` starts with `https://`;
  no `http://`, no `dangerousInsecureTransportProtocol`. The download URLs in `latest.json` are
  HTTPS as well.
- **The version goes up in X.Y.Z** with every release (see "Decision": the updater ignores the
  build number, so a release that differs only in B is never offered).
- **Authenticode on Windows.** The installer and the executable are signed with the code signing
  certificate in addition to the updater signature, so SmartScreen and the person see the
  publisher.
- **No updater rights in the frontend.** The capabilities grant no `updater:*` permission; the
  backend checks, downloads and installs through its own commands, so a compromised view cannot
  start or steer an update.

> [!question] Unverified
> The option names (`plugins.updater.pubkey`, `endpoints`, `dangerousInsecureTransportProtocol`,
> the `updater:*` permissions) are those of the Tauri 2 updater plugin as known from Hangar; check
> them against the plugin version added with the first release.

## Addendum 2026-11-27: the release script as built
`tools/release.py` (details: [[release-process]]) differs from the plan above in four points; the
rest of this decision stands.
- **Installer name with a hyphen.** Tauri names the installer `Hangar Note_X.Y.Z+B_x64-setup.exe`
  (unverified until the first build). The script copies it to `release/X.Y.Z-B/` as
  `Hangar-Note_X.Y.Z-B_x64-setup.exe`, because a space in a release asset name becomes `%20` in
  download links. The displayed form `X.Y.Z-B` is unchanged.
- **No `latest.json` (no updater yet).** Hangar Note has no `tauri-plugin-updater` and no
  `plugins.updater` in `src-tauri/tauri.conf.json`, so the script writes no `latest.json` and no
  updater signature. Every mention of `latest.json` in this decision applies once the updater is
  added, together with the section "Updater rules for the first release". Instead, every release
  ships `SHA256SUMS.txt`.
- **Release notes in English.** The release pages belong to the public repository, so the notes
  are the English items of the changelog entry, not the German ones.
- **Unsigned only on purpose.** Without an Authenticode setting the script refuses to build or
  publish unless `--allow-unsigned` is given; it then warns and adds a line to the release notes
  asking users to check the installer against `SHA256SUMS.txt`. The owner decided that the first
  release, 0.1.0, ships unsigned as a pre-release.

## Evidence
- [[version-number-wikipedia]] (parts, build number from version control, never reset, major 0).
- Hangar's ADR 0002 "Version scheme" and its code (`tools/release.py`, `src/versionSync.test.ts`,
  `src/changelog.ts`, `src/version.ts`, `vite.config.ts`), read on 2026-11-26 at Hangar 0.17.0.
- `try_add_numeric_build_number` in the Tauri bundler, tag `tauri-cli-v2.12.6` (see Context).
- Code: `src/versionSync.test.ts`, `src/changelog.json`, `tools/release.py`, `tools/test_release.py`.
