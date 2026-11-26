# Hangar Note

A desktop app for notes, part of the Hangar family. It takes over the notes area of the
[Hangar](https://github.com/feoren/hangar) desktop app and puts any note on the desktop as a sticky
note.

**Status:** in development, no release yet. Phase 1 of the takeover is built:

- **Hangar's private notes, in place.** Hangar Note reads and writes the notes Hangar keeps per
  working folder, in Hangar's own folder and format, without migrating anything. Until Hangar hands
  the notes over, Hangar Note shows them read only and writes nothing there.
- **The notes area:** scopes ("This project", "All", "General", another project), a search across
  all notes, quick notes (`Ctrl+Shift+N`) that get their title from the first line, rename (`F2`),
  a trash with undo and "Recently deleted", export, show in the file manager, copy as Markdown,
  and a Markdown editor with checkboxes, a preview, checklist progress and a word count.
- **Sticky notes:** any note can sit on the desktop in its own small window. While it does, that
  window is its only editor.
- **Color categories:** every note has one of eight colors, the list filters by one or more of them,
  and each color can get a name of your own.
- **For Hangar:** a command line (`hangar-note open | quick | capture`) and a token-protected
  loopback channel, through which Hangar will start and use Hangar Note.

Shared (encrypted) project notes and the integration on Hangar's side follow in later phases. The
design decisions are in [`docs/wiki`](docs/wiki/index.md).

## Platforms

- Windows 10 1809+ and Windows 11 (x64) first
- macOS 13+ (Apple silicon and Intel) and Linux x64 (X11 and Wayland) later

## Building

Requirements: Rust (stable), Node.js and pnpm.

```sh
pnpm install
pnpm tauri dev
```

In debug builds, the environment variable `HANGAR_NOTE_NOTES_ROOT` points the app at another notes
folder with Hangar's layout, so development never touches your real notes:

```sh
HANGAR_NOTE_NOTES_ROOT=/absolute/path/to/test-notes pnpm tauri dev
```

Checks:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm format:check && pnpm lint && pnpm test && pnpm build
```

## Built with

Tauri 2 (Rust) with React, TypeScript, Vite and CodeMirror.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems are reported privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
