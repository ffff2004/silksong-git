# Serve a secure versioned local HTTP Adapter from Repo Session

We decided that the local HTTP Adapter is owned by the Repo Session that
orchestrates file watching and calls History workflows. ADR-0020 supersedes the
original optional and atomic startup lifetime: HTTP is now mandatory on open,
while watcher ownership starts and stops independently. An unrecoverable
listener failure stops the whole session; an individual request failure does
not.

The first version binds only `http://127.0.0.1`; the host is fixed in the HTTP Adapter and is not a Project Config field. The default runtime port is `0`, allowing the operating system to choose an available port, while `--port <port>` may select an explicit port only with `--http`. The port and credentials are runtime state and are never written to Project Config. HTTPS, IPv6, LAN binding, user-provided certificates, and a CLI host override are outside this decision; adding LAN access would require a new threat model and ADR.

Each Repo Session open generates a new cryptographically secure random bearer
token of at least 256 bits, encoded as unpadded base64url. The token is held
only in session memory, compared in constant time, and accepted only through
`Authorization: Bearer <token>`. It is never accepted through a URL, cookie, or
alternate authentication scheme. The CLI may disclose the endpoint and token
once from its output Adapter; credentials do not enter general session events.
Missing, malformed, and incorrect credentials are indistinguishable to clients.

Cross-origin browser access uses standard CORS with `Access-Control-Allow-Origin: *`, no credentials, and an explicit allowlist of methods and headers. Unauthenticated `OPTIONS` preflight is the only authentication exception and exposes no repository state. Actual requests require the bearer token. Browser Local Network Access permission handling belongs to the Web client; the server does not implement the superseded Private Network Access response headers.

The Adapter uses Hono with its Node server Adapter and OpenAPI-aware Zod validation. Hono owns routing and HTTP middleware only. Route definitions are the runtime source for strict request validation and the generated OpenAPI 3.1 contract; response schemas are checked against public History DTOs. The ignored OpenAPI JSON artifact is generated on demand for clients and documentation tooling without adding a public or unauthenticated documentation route to Repo Session. Route handlers call public `packages/history` Interfaces and must not query SQLite, run Git, read watcher private fields, or create a second mutation queue. Existing repository write-lock behavior serializes checkpoint and in-place restore requests with watcher observations and Offline Commands. Hono request input is strictly validated, bounded, and mapped to a stable error contract; successful history responses reuse public history DTOs.

The contract is rooted at `/api/v1`. The bundled Web client starts with an authenticated `GET /api/v1/watcher`, whose successful response both probes the Repo Session and seeds the initial watcher status. The Web client and Repo Session ship in lockstep, so this adapter does not expose a separate metadata endpoint or perform runtime API version/capability negotiation. Hono app types may provide compile-time client typing through a type-only browser-safe export, but the executable route and wire schemas remain authoritative.

The first version uses polling rather than SSE or WebSocket. Watcher status exposes a coarse current-state snapshot, an `observationRevision` that increments when an observation completes, and only the latest observation summary. It is not a lossless session-event stream. When the revision changes, the Web client refreshes latest Save State and uses paginated History or Raw Observation queries to retrieve persistent changes. An explicitly selected historical commit remains immutable. Transient skipped observations and Watcher Errors are not a durable audit log.

HTTP restore exposes only in-place restore to the configured Watched Save. It does not expose arbitrary server filesystem targets. Every normal HTTP in-place restore uses the latest committed Raw Save Observation hash as its optimistic current-save precondition, even when restoring an older source commit. History re-reads the actual Watched Save after acquiring `write.lock`; a different file produces a restore conflict before backup or overwrite. This deliberately prevents restore from overwriting bytes that the watcher has not yet captured. The Web UI tells the user to wait for watcher synchronization or create a Manual Checkpoint and does not offer a current-file hash refresh that bypasses the invariant. A separate explicit missing-file confirmation may use the existing `missing` precondition; the server verifies absence and no original-file backup can be created. Export is a separate read-only endpoint that returns the exact committed `save.dat` bytes without writing a server path, but its action lives inside History rather than a separate Web view.

Shutdown first stops accepting HTTP work, closes idle connections, and allows authenticated handlers already inside public history Interfaces to finish. Mutations that may have changed Git, SQLite, or the Watched Save are never hard-cancelled because the client disconnected or the session received a stop signal. After active HTTP work and any running watcher observation finish, the session releases its resources and `watch.lock`.
