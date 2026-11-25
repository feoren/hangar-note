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
