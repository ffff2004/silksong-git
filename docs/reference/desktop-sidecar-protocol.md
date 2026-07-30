# Desktop Sidecar Process Protocol

The private `@silksong-git/desktop-sidecar` workspace application adapts the
public Repo Session Interface for a future Tauri Rust caller. It is currently a
Node.js development executable, not a packaged Tauri external binary. The
executable protocol schemas in
[`protocol.ts`](../../apps/desktop-sidecar/src/protocol.ts) are authoritative.

Run the development entry point from the workspace:

```sh
pnpm dev-desktop-sidecar
```

## Transport and envelopes

The protocol is UTF-8 JSON Lines. The caller writes one command envelope per
stdin line and continuously drains stdout and stderr. Stdout contains only
command responses and events; fixed diagnostic text uses stderr. A command
has this common envelope:

```json
{
  "protocolVersion": 1,
  "kind": "command",
  "requestId": "caller-unique-id",
  "command": { "type": "watcher.start" }
}
```

Every accepted line receives exactly one response with the same `requestId`.
Malformed envelopes use `null` because no request identity was accepted.
Success responses set `ok` to `true` and carry a discriminated `result`;
failures set it to `false` and carry a stable `error.code` plus a safe message.
Events have no request ID:

```json
{
  "protocolVersion": 1,
  "kind": "event",
  "event": { "type": "process.ready" }
}
```

Commands are processed serially. Events produced while a command runs are
buffered until that command's response has been flushed. Consumers must ignore
an event whose `event.type` they do not understand. They must reject malformed
payloads for known event types and protocol versions they do not support.

## Lifecycle

Version 1 accepts these commands:

- `session.open` with one absolute `repoPath`;
- `watcher.start`;
- `watcher.stop`; and
- `process.shutdown`.

A process may open at most one Repo Session. A successful `session.open`
response is emitted after authenticated loopback HTTP is ready and while the
watcher remains inactive:

```json
{
  "protocolVersion": 1,
  "kind": "response",
  "requestId": "open-1",
  "ok": true,
  "result": {
    "type": "session.opened",
    "connection": {
      "endpoint": "http://127.0.0.1:49152",
      "bearerToken": "<in-memory credential>"
    }
  }
}
```

This is the credential's only protocol disclosure. The token is not repeated
in events, later responses, diagnostics, command arguments, or the endpoint
URL. History and watcher status data remain on the authenticated Local HTTP
Interface; the process protocol does not duplicate them.

The current event types are:

- `process.ready`;
- `watcher.observation`, projected to cause, outcome, and safe outcome details;
- `watcher.failed`, without a raw error; and
- `session.failed`, without a raw error.

The sidecar never forwards repository paths, Watched Save paths, Semantic Event
payloads, commit references, or raw exception messages in events.

## Shutdown and exit classification

`process.shutdown` first calls the public Repo Session shutdown operation. Its
`process.shutdownComplete` response is written only after HTTP admission is
closed and admitted HTTP and watcher work has drained. The process then flushes
any buffered events and exits naturally with status zero.

A caller classifies shutdown as requested and graceful only when both the
matching `process.shutdownComplete` response and exit status zero are observed.
EOF, a signal, output failure, or a session-fatal failure has no matching
acknowledgment and follows a nonzero or signal exit path.

Unknown commands return `unknown_command`; incompatible versions return
`unsupported_protocol_version`; invalid JSON, framing, or envelopes return
`invalid_message`. These failures do not execute a Repo Session operation.
