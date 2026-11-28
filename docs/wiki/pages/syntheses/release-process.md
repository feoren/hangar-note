---
title: Release process (tools/release.py)
type: synthesis
tags: [release, version, forgejo, github, signing, checksums]
sources: []
created: 2026-11-27
updated: 2026-11-28
---

# Release process

Decision: [[0003-version-scheme]] (version scheme, changelog rules, release script). Code:
`tools/release.py`, tests `tools/test_release.py`. Modeled on Hangar's release script, without
the updater parts: Hangar Note has no auto-updater yet (no `tauri-plugin-updater` in
`src-tauri/Cargo.toml`, no `plugins.updater` in `src-tauri/tauri.conf.json`), so there is no
`latest.json` and no updater signature.

## Steps

Three separate steps; the script never commits and prints the files to commit.

1. `py -3 tools/release.py --version X.Y.Z [--allow-unsigned] [--dry-run]` (Windows): checks the
   version rules of [[0003-version-scheme]], a clean working tree and build inputs Git does not
   see, dates the changelog entry, writes `X.Y.Z+B` (B = `git rev-list --count HEAD`, no base)
   into the four version files and runs `tauri build --bundles nsis`. The result goes to
   `release/X.Y.Z-B/`: `Hangar-Note_X.Y.Z-B_x64-setup.exe`, `SHA256SUMS.txt` and `BUILD_COMMIT`
   (the id of the built commit, not uploaded).
2. Commit the release state as one commit that changes only the version files and the changelog.
3. `py -3 tools/release.py --publish forgejo [--prerelease] [--draft] [--allow-unsigned]`: tags
   `vX.Y.Z`, pushes main and the tag to the project's own Forgejo instance and creates the release
   there through the Forgejo API, as a draft until the installer and `SHA256SUMS.txt` are
   attached. The first release, 0.1.0, is planned as an unsigned pre-release:
   `--prerelease --allow-unsigned` (the owner's decision); `--draft` keeps it unpublished until
   it is released in Forgejo by hand.
4. Later, after the go for GitHub:
   `py -3 tools/release.py --publish github --release X.Y.Z [--prerelease] [--allow-unsigned]`
   uploads the same files without building again, through `gh release create`. After the
   Forgejo step the script prints this command with the same `--prerelease` and
   `--allow-unsigned` flags, so a pre-release never becomes GitHub's latest release.
5. `py -3 tools/release.py --next X.Y.Z` starts the upcoming version (files without B, empty
   undated changelog entry).

## README screenshots

Before the build, `pnpm readme:shots` (`tools/readme-shots/run.mjs`, modeled on Hangar's tool)
renders the README images into `docs/images/` from the real frontend with a mocked backend
(`tools/readme-shots/mock.ts`) in a headless Edge or Chrome: one image per scene and color
scheme, 1296 x 839, at most 300 KB. `--scene <name>` renders single scenes. Temporary files stay
under `tests/.tmp/readme-shots/` and are removed at the end; a running app is never touched.

Current scenes (files `<file>-dark.png` and `<file>-light.png`):

| Scene | File | Shows |
| --- | --- | --- |
| `overview` | `hangar-note` | the README hero: main window in the Hangar look |
| `drive` | `hangar-note-drive` | the cloud mark of notes Hangar Drive keeps, "On your server" |
| `sticky` | `hangar-note-sticky` | a sticky note with line numbers and their switch |
| `paper` | `hangar-note-paper` | the Paper look |
| `look-switch` | `hangar-note-look-switch` | close-up of the look switch |
| `settings` | `hangar-note-settings` | the Hangar Drive section of the settings |
| `projects` | `hangar-note-projects` | the Project level with a chosen project folder |

The images show the upcoming version without a build number: the release commit may change only
the version files and the changelog, so they are not rendered again after the build.

## Safety rules carried over from Hangar

- git, node, gh and PowerShell only as absolute programs from PATH, never from the repository or
  the working folder; on Windows only `.exe`.
- git runs without fsmonitor, hooks, filters and tag signing, and without `GIT_*` variables except
  the SSH ones for pushes.
- `tauri build` through node.exe and the CLI's `tauri.js`, never through the `pnpm.cmd` shim; the
  installed CLI must match `pnpm-lock.yaml`.
- No child process sees a variable ending in `_TOKEN` (gh keeps its own), a Tauri signing key
  variable or the `HANGAR_NOTE_*` signing settings. The Authenticode setting reaches Tauri as a
  `--config` file under the git-ignored `release/`, removed after the build.

## Rules added for two targets

- **Never `git push origin`.** origin has two push URLs (Forgejo and GitHub). The script pushes
  only to URLs: the fetch URL of origin for Forgejo, the single push URL of the remote `github` for
  GitHub; `push_command` refuses remote names.
- **No redirected push.** Before pushing, the script aborts when a remote is named like a URL, an
  `insteadOf` or `pushInsteadOf` rule mentions the target host or matches the URL, or the
  repository's own config (`.git/config` and every file it includes, read with
  `git config --local --includes`, also from outside the repository) sets `core.sshCommand`,
  `core.askPass` or `credential.*`. After the push, `git push --porcelain` must report exactly the
  expected URL.
- **Forgejo first.** `--publish github` needs the local tag the Forgejo step created and checks
  that the tagged `tauri.conf.json` carries the built version.
- **Never overwrite.** An existing tag (local or remote) or release with the same version aborts.
  If the push fails, the script names the local tag to delete before the next try.
  The token must have push permission (`permissions.push` of the repository) before the tag is
  pushed.
- **The tag names the built source.** The release commit must be exactly one commit after
  `BUILD_COMMIT`, changing only the version files and the changelog.
- **The checked bytes are the uploaded bytes.** `SHA256SUMS.txt` must list exactly the installer;
  links, Windows reparse points and folders outside `release/` are refused. Each file is read once
  and the Forgejo upload sends those bytes. gh reads the files itself, so their hashes are checked
  right before and after `gh release create`.
- **API access.** HTTPS only, redirects refused, the token only in the `Authorization` header and
  never in output, errors or files. `FORGEJO_URL` and `FORGEJO_TOKEN` come from the environment or
  the git-ignored `.env` (plain `KEY=VALUE`, nothing runs, ` #` starts a comment after an unquoted
  value); without `FORGEJO_URL`, `https://<host of origin>`.
- **Unsigned only on purpose.** Without Authenticode the script refuses to build or publish unless
  `--allow-unsigned` is given; it then warns and adds a line to the release notes asking users to
  check the installer against `SHA256SUMS.txt`.

The release notes are the English items of the changelog entry, because the release pages belong
to the public repository.

> [!note] Deviations from ADR 0003
> Recorded in the addendum of 2026-11-27 in [[0003-version-scheme]]: the installer is published
> as `Hangar-Note_X.Y.Z-B_x64-setup.exe` (hyphen instead of Tauri's space, which becomes `%20` in
> download links), no `latest.json` (no updater yet), English release notes, and an unsigned
> build only with `--allow-unsigned`.

> [!question] Unverified
> - The release asset API (`attachment` form field, `name` query) was read from the instance's own
>   API description on 2026-11-27; no release has been created with it yet.
> - `tauri build --bundles nsis` and the installer name `Hangar Note_<version>_x64-setup.exe` are
>   taken from Hangar; confirm both with the first build.
> - That git prints the push URL without user information after `To ` is an assumption; the check
>   accepts both forms.
