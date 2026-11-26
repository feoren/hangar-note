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
`src-tauri/src/channel/` (`mod.rs` routes, server and client; `proof.rs` the server proof;
`slots.rs` connection slots; `http.rs` the HTTP subset), `src-tauri/src/winsec.rs` (Windows DACL
and `SO_EXCLUSIVEADDRUSE`), `src-tauri/src/cli.rs`, `src-tauri/src/install.rs`. Contract version 1.

## Files in Hangar Note's local data folder (`com.feoren.hangar-note`)
- `install.json` `{ version: 1, contract: 1, exe, appVersion }`, written atomically on every start
  (a debug start writes the debug executable).
- `endpoint.json` `{ version: 1, port, pid, token }`, written atomically on every start and
  removed on quit if it is still this run's. Owner only: 0600 on Unix; on Windows created through
  `CreateFileW` with an explicit protected DACL `D:P(A;;FA;;;SY)(A;;FA;;;<user SID>)`, so no ACE is
  inherited from the folder. `token` is 64 lowercase hex digits (32 random bytes), new each start.
  A crash leaves the file behind; a client then finds nothing listening, or a program that took
  the port and cannot prove itself, and treats the app as not running.

## Command line
```text
hangar-note                                   the app
hangar-note open [--folder P] [--shared] [--note ID]
hangar-note quick [--folder P]
hangar-note capture --folder P                text on stdin, at most 1 MiB UTF-8
```
`--folder` must be absolute and becomes "This project". `--shared` prints a notice and opens the
private notes (shared notes come in phase 3). A second start hands its arguments to the running
app through the single-instance plugin; `capture` sends its text over the channel instead (argv on
Windows is limited to 32 767 characters).

`capture` exits 0 only once the running app answered `{ ok: true }` with a valid proof:

| Exit | Meaning |
|---|---|
| 0 | delivered and confirmed |
| 1 | failed: refused for another reason (`too-large`, `invalid`, ...) or the channel broke before the text went out |
| 2 | wrong command line, or more than 1 MiB or no UTF-8 on stdin |
| 3 | read only: the running app answered `read-only`, or no app runs and Hangar has not handed the folder over (the app is then not started) |
| 4 | not delivered: the text went out but no proven answer came back, or an app runs whose channel did not answer (the capture guard) |

Without a running app (no endpoint, nobody listening, or no valid proof) the capturing process
becomes the app and keeps the text in memory. Should another Hangar Note hold the single instance
after all, the plugin would forward the arguments only and exit 0; a capture guard (a Tauri
resource dropped by the plugin's `cleanup_before_exit`) exits 4 first. Verified in the code of
tauri 2.12.7 and tauri-plugin-single-instance 2.5.5 for Windows and Linux.

> [!question] Unverified
> On macOS the single-instance plugin exits without `cleanup_before_exit`, so this rare case
> (an app running without a working channel) still ends with 0 there.

## HTTP
- `POST http://127.0.0.1:<port>/<route>`, `Host: 127.0.0.1:<port>`,
  `Content-Type: application/json`, `X-Channel-Nonce: <64 lowercase hex>`, `Content-Length`; for
  every route but the hello also `Authorization: Bearer <token>` and a JSON body with
  `version: 1`. One request per connection, `Connection: close`.
- Checked in this order: any `Origin` or `Sec-Fetch-*` header or another `Host` (403
  `forbidden`), a `Content-Type` other than `application/json` with optional parameters (415
  `unsupported-media-type`), a missing or malformed nonce (400 `bad-request`), then the token in
  constant time (401 `unauthorized`).
- Body limits: 0 for the hello, 8 MiB for `capture` and `create` (1 MiB of text, JSON escaping
  included), 64 KiB for the rest, checked before the body is read.
- Connections: until its head is read, a connection holds one of 16 head slots and has 2 s for the
  whole head. With all taken, a new one closes the oldest connection that waited at least 1 s with
  nothing of its head arrived; past 32 head threads with none silent, a new one is closed
  unanswered. An authenticated request then holds one of 16 slots (beyond: 503 `busy`) with 15 s
  for its body. Taken from Hangar's gate (`gate_service.rs`).
- On Windows the socket is bound with `SO_EXCLUSIVEADDRUSE`, so no other socket can share the
  address while the app runs.
- Answers always carry `version: 1`. Errors: `{ version: 1, error: <code> }` with the codes
  `bad-request`, `unsupported-version`, `unauthorized`, `forbidden`, `unknown-route`,
  `method-not-allowed`, `length-required`, `too-large`, `unsupported-media-type`,
  `headers-too-large`, `not-implemented`, `busy` (503), `read-only` (409), `unknown-note` (404),
  `invalid`, `internal`.

## Server proof
1. The client reads `endpoint.json`, makes a fresh nonce (32 random bytes as 64 lowercase hex) and
   sends `POST /v1/hello` with `Content-Type`, the nonce, `Content-Length: 0`, and **no token and no
   body**. Sending the token here would let a program on a stale port learn it and prove itself to
   the next client.
2. The server answers 200 `{"version":1}` with
   `X-Channel-Proof: hex(HMAC-SHA256(key, nonce || status || body))`:
   `key = SHA-256("hangar-channel-server" || token)`, `token` its 64 ASCII hex digits as written in
   `endpoint.json`, `nonce` the 64 ASCII hex digits as sent, `status` 3 ASCII digits, `body` the
   exact bytes after the blank line. The proof is 64 lowercase hex digits.
3. The client compares in constant time. Without status 200 and a valid proof it sends nothing
   else and treats the app as not running.
4. The real request carries a new nonce and the token; its answer (errors included) carries the
   proof over that nonce. An answer without a valid proof counts as not delivered.

Known answer (computed with Python's `hashlib` and `hmac`, pinned in
`src-tauri/src/channel/proof.rs`): token `0123456789abcdef` × 4, nonce `fedcba9876543210` × 4,
key `501e571e…4eabe0c`; status 200 with body `{"version":1}` gives
`e3ad221eff7e1867f489a5e11f72acef5f310bb91349fb4c85416af3072d4bd8`.

## Routes

| Route | Body | Answer |
|---|---|---|
| `v1/hello` | none (token not sent) | `{ version: 1 }` with the proof |
| `open` | `folder?`, `shared?`, `note?` | `{ ok: true }`, with `shared: "unavailable"` when asked for |
| `quick` | `folder?` | `{ ok: true }` |
| `capture` | `folder`, `text` | `{ ok: true }`; a new note in `folder` shows in the notes area; `read-only` (409) while read only |
| `create` | `folder?`, `title`, `text?` | `{ id }` |
| `search` | `query` | `{ hits: [{ folderKey, path, id, title, excerpt, updatedAt, color, onDesktop }] }` |
| `excerpts` | `folder?`, `limit?` | `{ notes: [{ id, title, excerpt, updatedAt }] }`, newest first, at most 200 |
| `flush` | none | `{ saved }`: every editor was asked to save, `true` once all answered saved |

Neither note text nor the token is ever logged; the request kinds log by name only. The token,
the proof key and the endpoint file's bytes are held in `Zeroizing` and never shown by `Debug`.

## Verified
- Tests in `src-tauri/src/channel/` (2026-11-26, Windows 11): RFC 4231 vectors and the known
  answer above; the server's checks (wrong or missing token, foreign host, browser origin, 415,
  missing or malformed nonce, body limit, `GET`); hello without token, proof on errors; a squatter
  listener with a wrong proof sees only the hello, neither text nor token; 16 silent connections
  and a valid request gets 200; with 32 silent ones the oldest is closed for it; a read-only
  `capture` arrives as `read-only`; a 400 000-character capture over a real socket; nobody
  listening; on Windows a second socket with `SO_REUSEADDR` cannot bind the address, and
  `endpoint.json`'s DACL is protected with exactly SYSTEM and the user (no `BU`, `WD`, `AU`).
- Manual run on Windows 11 on 2026-11-26 with a development root under `tests/.tmp/`:
  `endpoint.json` with `pid`, `icacls` shows SYSTEM and the user only; `hangar-note capture` from a
  pipe exits 0 and the note is found by `search`; an independent Python client verified the proof
  of `/v1/hello` and of `search`, and got 415 for a hello without `Content-Type` and for
  `text/plain`; unknown command exits 2.
- Earlier manual run (phase 1): `create`, `search`, `excerpts`, wrong version (400), no token
  (401), `Origin` (403), `flush` (200), `open --shared --folder` forwarded to the running app.
