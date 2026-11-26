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
- `endpoint.json` `{ version: 1, port, pid, token, teamToken }`, written atomically on every
  start and removed on quit if it is still this run's. Owner only: 0600 on Unix; on Windows created
  through `CreateFileW` with the descriptor
  `D:P(A;;FA;;;SY)(A;;FA;;;<user SID>)S:(ML;;NWNRNX;;;ME)`: an explicit protected DACL, so no ACE
  is inherited from the folder, and a medium integrity label, so no process below medium integrity
  may read, write or execute it. `token` and `teamToken` are 64 lowercase hex digits each (32
  random bytes), new each start; a file without `teamToken`, or with the same value twice, is
  refused.
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
| 3 | read only: the running app answered `read-only` (another Hangar Note holds the writer lock), or no app runs and no notes root resolves (the app is then not started); since [[0005-shared-notes-folder]] there is no handover to wait for |
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
  `version: 1`.
- **One exchange, one connection:** the hello goes out with `Connection: keep-alive`, the real
  request on the same connection with `Connection: close`. The server keeps the connection after a
  hello only if the client did not ask to close and a head slot for the request is free; it says
  so with `Connection: keep-alive` in the hello's answer. The request after a hello is the last;
  anything else (a request without a hello, a hello with `Connection: close`, HTTP/1.0 without
  keep-alive) closes after its answer. Every answer carries `Content-Length`.
- **Scopes:** every route under `/team/` takes `teamToken` only, every other route `token` only.
  Phase 1 has no team route, so a team path with `teamToken` gets `unknown-route` (404) and with
  `token` `unauthorized` (401). The proof key comes from `token` in both scopes.
- Checked in this order: any `Origin` or `Sec-Fetch-*` header or another `Host` (403
  `forbidden`), a `Content-Type` other than `application/json` with optional parameters (415
  `unsupported-media-type`), a missing or malformed nonce (400 `bad-request`), then the token of
  the route's scope in constant time (401 `unauthorized`).
- Body limits: 0 for the hello, 8 MiB for `capture` and `create` (1 MiB of text, JSON escaping
  included), 64 KiB for the rest, checked before the body is read.
- Connections: until its head is read, a connection holds one of 16 head slots and has 2 s for the
  whole head. With all taken, a new one closes the oldest silent connection (nothing of its head
  arrived) whose grace is over: 1 s for a new connection, 250 ms for one waiting for its request
  after a hello. Past 32 head threads with none silent, a new one is closed unanswered. A
  connection gives its head slot back as soon as its head is read, before it is answered. An
  authenticated request then holds one of 16 slots (beyond: 503 `busy`) with 15 s for its body,
  and its answer waits up to 1 s for the client to finish. An answer without a valid token (a
  hello that closes, any refusal) waits at most 100 ms, and only while fewer than 32 others do;
  beyond, the socket closes at once. Taken from Hangar's gate (`gate_service.rs`), plus the second
  security review (N-C: finished hellos must not fill the slots).
- On Windows the socket is bound with `SO_EXCLUSIVEADDRUSE`, so no other socket can share the
  address while the app runs.
- Answers always carry `version: 1`. Errors: `{ version: 1, error: <code> }` with the codes
  `bad-request`, `unsupported-version`, `unauthorized`, `forbidden`, `unknown-route`,
  `method-not-allowed`, `length-required`, `too-large`, `unsupported-media-type`,
  `headers-too-large`, `not-implemented`, `busy` (503), `read-only` (409), `unknown-note` (404),
  `invalid`, `internal`, and the storage codes `denied` (500), `disk-full` (500), `not-found`
  (404), `io` (500) and `too-large` (413, also for a note over 1 MiB in `create`). A storage code
  never carries the OS text or a path. Hangar Note's log names only the scope key, the kind of
  file and the OS error number (`fsio::storage_log`, finding B3 of the complete security review).

## Storage codes
The same five codes reach the window (`src/api.ts` `storageError`, one sentence each in
`src/i18n.ts` under `storage.*`) and the channel. Mapped in `src-tauri/src/fsio.rs`
(`StorageCode::of`), the OS error number first, then the portable `io::ErrorKind`:

| Code | Windows | Unix | Kind |
|---|---|---|---|
| `denied` | 5 access denied, 19 write protect, 32 sharing violation, 33 lock violation | `EACCES`, `EPERM`, `EROFS` | `PermissionDenied`, `ReadOnlyFilesystem` |
| `disk-full` | 39, 112 | `ENOSPC` | `StorageFull`, `QuotaExceeded` |
| `too-large` | | `EFBIG` | `FileTooLarge`; a note over 1 MiB |
| `not-found` | 2, 3 | `ENOENT` | `NotFound`; an unknown note (window only) |
| `io` | anything else | anything else | anything else |

## Server proof
1. The client reads `endpoint.json`, makes a fresh nonce (32 random bytes as 64 lowercase hex) and
   sends `POST /v1/hello` with `Content-Type`, the nonce, `Content-Length: 0`, and **no token and no
   body**. Sending the token here would let a program on a stale port learn it and prove itself to
   the next client.
2. The server answers 200 `{"version":1}` with
   `X-Channel-Proof: hex(HMAC-SHA256(key, nonce || path || status || body))`:
   `key = SHA-256("hangar-channel-server" || token)`, `token` its 64 ASCII hex digits as written in
   `endpoint.json`, `nonce` the 64 ASCII hex digits as sent, `path` the request's path exactly as
   sent and routed on (ASCII, no query: `/v1/hello`, `/capture`, `/team/...`), `status` 3 ASCII
   digits, `body` the exact bytes after the blank line. The proof is 64 lowercase hex digits.
   Binding the path (security review L1b, contract 1 changed before it was frozen, agreed with
   Hangar) means an answer proven for one route never passes for another. The known answer
   below includes the path.
3. The client compares in constant time. Without status 200 and a valid proof it sends nothing
   else and treats the app as not running. A proven answer with `Connection: close` ends the
   exchange as `busy` (the app runs but takes no request now). Before the request, the client
   looks for 2 ms whether the server closed or reset the connection or sent anything more; then
   it sends nothing and treats the app as not running.
4. The real request carries a new nonce and the token of its scope, on the same connection; its
   answer (errors included) carries the proof over that nonce and that request's path. An answer
   without a valid proof counts as not delivered. On `open`, `quick` and `capture` a proven 200
   counts only with `"ok": true` in the body; anything else is refused as `invalid`
   (`channel::post_confirmed`, security review L1).

Known answer (computed with Python's `hashlib` and `hmac`, pinned in
`src-tauri/src/channel/proof.rs`): token `0123456789abcdef` × 4, nonce `fedcba9876543210` × 4,
key `501e571e…4eabe0c`; path `/v1/hello`, status 200 and body `{"version":1}` give
`7c4469d30cb086970cbf2786c2d5f0803277d036a002776156c76cb97d3a3b8e`; path `/capture`, status 409
and body `{"version":1,"error":"read-only"}` give
`5d5c0f2ff0c3182cb072618dcc7be561d44b0c6cccf116cb84771dfd2d773f19`.

## Routes

| Route | Body | Answer |
|---|---|---|
| `v1/hello` | none (token not sent) | `{ version: 1 }` with the proof |
| `open` | `folder?`, `shared?`, `note?` | `{ ok: true }`, with `shared: "unavailable"` when asked for |
| `quick` | `folder?` | `{ ok: true }` |
| `capture` | `folder`, `text` | `{ ok: true, id }` once the note is on disk; `read-only` (409) while read only, and no file is written |
| `create` | `folder?`, `title`, `text?` | `{ id }` |
| `search` | `query` | `{ hits: [{ folderKey, path, id, title, excerpt, updatedAt, color, onDesktop }] }` |
| `excerpts` | `folder?`, `limit?` | `{ notes: [{ id, title, excerpt, updatedAt }] }`, newest first, at most 200 |
| `flush` | none | `{ saved }`: every editor was asked to save, `true` once all answered saved |
| `team/...` | | none in phase 1; takes `teamToken` only |

Neither note text nor a token is ever logged; the request kinds log by name only. Both tokens,
the proof key and the endpoint file's bytes are held in `Zeroizing` and never shown by `Debug`.

### `capture` (complete security review, finding B1)
- The backend writes the note before it answers: `NotesService::capture` with the capture block
  that `appendCapture` (`src/noteText.ts`) used to build in the window, ported to
  `src-tauri/src/capture.rs` with the same test cases. Heading
  `_<notes.capturedFrom>_` ("From {source}, {time}" and its eleven translations), `{source}` the
  last part of `folder`, `{time}` as `captureStamp` (`Intl.DateTimeFormat` with `day: numeric,
  month: short, hour: 2-digit, minute: 2-digit`, the strings of Node 26.13.1 / ICU 78.3 pinned in
  the tests), then the text in a code fence it does not contain. The language is `language` in
  `settings.json`, English without one; the time is the computer's local time (`GetLocalTime` on
  Windows, `localtime_r` elsewhere). The title follows the first line (`titleFromText`), and the
  note stays auto titled as a quick note does; color: `newNoteColor`.
- Only then does the route answer `{ ok: true, id }`; the notes area gets
  `{ kind: "openNote", folder, id }`, never the text. A full request queue or a notes area that
  never loads loses nothing.
- Requests waiting for the notes area: beyond 32, the oldest without content (`showProject`,
  `quick`, `openNote`, `sharedUnavailable`) are dropped, a held `capture` never. That
  `{ kind: "capture", folder, text }` remains only for a capture that started the app itself and
  whose note could not be written there (still read only, a storage failure): the notes area then
  holds the text in a draft to copy, as before.
- Tests (`src-tauri/src/lib.rs`, real `NotesStore` under `tests/.tmp/`): after `ok` the `.md` with
  the marker text is on disk without anyone taking the requests; 33 captures are 33 notes; read
  only answers 409 and leaves the folder empty.

### Memory of tokens (finding B5)
Every request and answer head is read through `channel::http::WipingReader`, whose buffer is
overwritten as it is consumed and when dropped (`std::io::BufReader` kept the head with the bearer
token until reused). Head lines, the client's request head and the JSON of the endpoint file and
of the client's body are built in buffers of their final size (`to_json_wiped` measures first),
so no growing buffer leaves a copy behind. Test: after `read_head` the buffer no longer holds the
marker token.

## Verified
- Tests in `src-tauri/src/channel/` (2026-11-26, Windows 11): RFC 4231 vectors and the known
  answer above; the server's checks (wrong or missing token, foreign host, browser origin, 415,
  missing or malformed nonce, body limit, `GET`); hello without token, proof on errors; a squatter
  listener with a wrong proof sees only the hello, neither text nor token; 16 silent connections
  and a valid request gets 200; with 32 silent ones the oldest is closed for it; a read-only
  `capture` arrives as `read-only`; a 400 000-character capture over a real socket; nobody
  listening; on Windows a second socket with `SO_REUSEADDR` cannot bind the address, and
  `endpoint.json`'s DACL is protected with exactly SYSTEM and the user (no `BU`, `WD`, `AU`).
- Tests after the second security review (2026-11-26, Windows 11): hello and request on one
  connection, both proven, then EOF; a second hello on the same connection is the last; the client
  opens exactly one connection; a server that closes after a proven hello, or answers it with
  `Connection: close`, sees nothing but the hello (no token, no text); four threads sending
  complete hellos with `Connection: close` without pause, never reading or closing, and three
  valid exchanges among them get 200 (with the old order, head slot held during a 1 s linger, the
  same test fails with `NotProven`); 32 connections silent after their hello give way after
  250 ms; team routes refuse `token`, `/flush` refuses `teamToken`; `endpoint.json` needs two
  different tokens; storage failures over the channel arrive as codes without the file name; the
  label reads back as `S:AI(ML;;NWNRNX;;;ME)` through `LABEL_SECURITY_INFORMATION`, also after the
  file is replaced.
- Manual check on 2026-11-26: a file written by `write_atomic_owner_only` under `tests/.tmp/`
  shows in `icacls` SYSTEM and the user with `(F)` and
  `Mandatory Label\Medium Mandatory Level:(NW,NR,NX)` (German Windows: "Verbindliche
  Beschriftung\Mittlere Verbindlichkeitsstufe").

> [!question] Unverified
> That a process of low integrity is refused reading `endpoint.json` was not observed directly; it
> follows from the label and Windows' mandatory integrity check. Errno values on macOS and Linux
> were not run (the Unix test runs in CI only).

- Manual run on Windows 11 on 2026-11-26 with a development root under `tests/.tmp/`:
  `endpoint.json` with `pid`, `icacls` shows SYSTEM and the user only; `hangar-note capture` from a
  pipe exits 0 and the note is found by `search`; an independent Python client verified the proof
  of `/v1/hello` and of `search`, and got 415 for a hello without `Content-Type` and for
  `text/plain`; unknown command exits 2.
- Earlier manual run (phase 1): `create`, `search`, `excerpts`, wrong version (400), no token
  (401), `Origin` (403), `flush` (200), `open --shared --folder` forwarded to the running app.
