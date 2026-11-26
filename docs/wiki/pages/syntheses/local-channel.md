---
title: Local channel and command line (contract, Hangar Note side)
type: synthesis
tags: [contract, ipc, cli, security]
sources: []
created: 2026-11-26
updated: 2026-11-26
---

# Local channel and command line

Decision: [[0002-hangar-notes-takeover]] ("Detection and start", "Local channel"). Code:
`src-tauri/src/channel/`, `src-tauri/src/cli.rs`, `src-tauri/src/install.rs`. Contract version 1.

## Files in Hangar Note's local data folder (`com.feoren.hangar-note`)
- `install.json` `{ version: 1, contract: 1, exe, appVersion }`, written atomically on every start.
- `endpoint.json` `{ version: 1, port, token }`, written atomically on every start (0600 on Unix,
  the profile's ACL on Windows), removed on quit if it is still this run's. A crash leaves it
  behind; a client then finds nothing listening and treats the app as not running.

## Command line
```text
hangar-note                                   the app
hangar-note open [--folder P] [--shared] [--note ID]
hangar-note quick [--folder P]
hangar-note capture --folder P                text on stdin, at most 1 MiB UTF-8
```
`--folder` must be absolute and becomes "This project". `--shared` prints a notice and opens the
private notes (shared notes come in phase 3). A wrong command line exits with code 2 before
anything starts. A second start hands its arguments to the running app through the single-instance
plugin; `capture` sends its text over the channel instead (argv on Windows is limited to 32 767
characters) and exits 0 once delivered. Without a running app it starts the app itself with the
text.

## HTTP
- `POST http://127.0.0.1:<port>/<route>`, `Host: 127.0.0.1:<port>`, `Authorization: Bearer <token>`,
  `Content-Length`, a JSON body with `version: 1`. One request per connection, `Connection: close`.
- Refused before the token is looked at: any `Origin` or `Sec-Fetch-*` header (a web page), any other
  `Host`. The token (32 random bytes, 64 hex digits, new each start) is compared in constant time.
- Body limits: 8 MiB for `capture` and `create` (1 MiB of text, JSON escaping included), 64 KiB for
  the rest, checked before the body is read. At most 16 connections at once; 5 s for the head,
  15 s for the body.
- Answers always carry `version: 1`. Errors: `{ version: 1, error: <code> }` with the codes
  `bad-request`, `unsupported-version`, `unauthorized`, `forbidden`, `unknown-route`,
  `method-not-allowed`, `length-required`, `too-large`, `headers-too-large`, `not-implemented`,
  `read-only` (409), `unknown-note` (404), `invalid`, `internal`.

| Route | Body | Answer |
|---|---|---|
| `open` | `folder?`, `shared?`, `note?` | `{ ok: true }`, with `shared: "unavailable"` when asked for |
| `quick` | `folder?` | `{ ok: true }` |
| `capture` | `folder`, `text` | `{ ok: true }`; a new note in `folder` shows in the notes area |
| `create` | `folder?`, `title`, `text?` | `{ id }` |
| `search` | `query` | `{ hits: [{ folderKey, path, id, title, excerpt, updatedAt, color, onDesktop }] }` |
| `excerpts` | `folder?`, `limit?` | `{ notes: [{ id, title, excerpt, updatedAt }] }`, newest first, at most 200 |
| `flush` | none | `{ saved }`: every editor was asked to save, `true` once all answered saved |

Neither note text nor the token is ever logged; the request kinds log by name only.

## Verified
- Unit and socket tests in `src-tauri/src/channel/mod.rs` (wrong token, foreign host, browser
  origin, body limit, `GET`, a 400 000-character capture over a real socket, nobody listening).
- Manual run on Windows 11 on 2026-11-26 with a development root: `create`, `search`, `excerpts`,
  wrong version (400 `unsupported-version`), no token (401), `Origin` (403), `flush` (200), and
  `hangar-note capture` from a pipe (exit 0, note shown), `open --shared --folder` forwarded to the
  running app (notice shown, "This project" chosen), unknown command (exit 2).
