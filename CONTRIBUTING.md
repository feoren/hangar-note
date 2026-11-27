# Contributing to Hangar Note

Thanks for your interest. Bug reports, ideas and pull requests are welcome.
Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- For larger changes, open an issue first so we can agree on the approach.
- The rules below apply to every change; design decisions are recorded in [`docs/wiki`](docs/wiki/index.md).
  Please write issues and pull requests in English.

## Development

Hangar Note is a Tauri 2 app. You need Rust (stable), Node.js and pnpm, plus the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```sh
pnpm install
pnpm tauri dev
```

The whole check suite must pass before a pull request is merged:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm format:check && pnpm lint && pnpm test && pnpm build
```

`pnpm tauri build` builds an installer.

## Releases (maintainers)

Releases are built with `py -3 tools/release.py` on Windows and published first on the project's
own Forgejo instance, later on GitHub. The steps are separate and the script never commits:

```sh
py -3 tools/release.py --version 0.1.0 --dry-run   # what a release would do
py -3 tools/release.py --version 0.1.0             # date the changelog, set 0.1.0+B, build
# commit the version files and the changelog as one release commit
py -3 tools/release.py --publish forgejo --prerelease --allow-unsigned --draft
py -3 tools/release.py --publish github --release 0.1.0 --prerelease --allow-unsigned   # the same files, no new build
py -3 tools/release.py --next 0.2.0                # start the upcoming version
```

Every release ships `SHA256SUMS.txt`. An installer without an Authenticode signature is built or
published only with `--allow-unsigned`. The Forgejo step reads `FORGEJO_URL` and `FORGEJO_TOKEN`
from the environment or from the git-ignored `.env`. Details: [`docs/wiki/pages/syntheses/release-process.md`](docs/wiki/pages/syntheses/release-process.md).

## Guidelines

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org) in English
  (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), one logical change per commit.
- **Tests:** new behavior comes with a test. A bug gets a failing test first, then the fix. Tests are
  never weakened to make them pass. Test files go under the git-ignored `tests/.tmp/`, never into the
  system temp folder.
- **Rust:** no `unwrap`/`expect` outside tests unless an invariant is documented; `thiserror` in
  modules; `unsafe` only with a `// SAFETY:` comment.
- **TypeScript:** `strict`, no `any`, no unchecked casts.
- **Processes:** always start programs as an argv array, never as a shell string.
- **Shortcuts:** never bind `Ctrl+<letter>` alone where a text field needs it. Shortcuts live in one
  module and have tests.
- **Dependencies:** add one only with a justification covering maintenance status, license
  (MIT, Apache-2.0 or BSD) and size.
- **UI text:** add every new string to the i18n module in all supported languages.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
