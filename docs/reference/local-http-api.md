# Local HTTP API Reference

The Local HTTP API is the authenticated browser and tool boundary for one
running Repo Session. It adapts the public Save History Module
Interface; it is not a second persistence path or a frontend server.

## Executable Contract

Runtime schemas are authoritative for request and JSON response data. The
generated OpenAPI document is a discovery artifact derived from those schemas
and the route registry, not a separate source of truth.

| Contract question                                                                                                         | Executable source                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error codes, query and body validation, response schemas, JSON success and error shapes                                   | [`http-wire.ts`](../../packages/repo-session/src/http-wire.ts)                                                                                                                         |
| Methods, paths, route-declared media types, statuses and headers, and OpenAPI composition                                 | [`http-contract.ts`](../../packages/repo-session/src/http-contract.ts)                                                                                                                 |
| Authentication, CORS, request limits, handler and fallback behavior, runtime-only statuses and headers, and error mapping | [`http-app.ts`](../../packages/repo-session/src/http-app.ts)                                                                                                                           |
| Executable examples and edge-case behavior                                                                                | [`http-app.test.ts`](../../packages/repo-session/src/http-app.test.ts) and [`http-wire.test.ts`](../../packages/repo-session/src/http-wire.test.ts)                                    |
| Browser-side authentication, response validation, and request behavior                                                    | [`local-history-client.ts`](../../apps/web/src/features/local-history/local-history-client.ts) and its [tests](../../apps/web/src/features/local-history/local-history-client.test.ts) |

Client code can import the browser-safe schemas and inferred DTOs from
`@silksong-git/repo-session/http-wire`. Clients that need an exhaustive endpoint or
schema listing should generate the OpenAPI document instead of copying the
route registry into another document.

### Generate OpenAPI

From the repository root, run:

```sh
pnpm generate:openapi
```

The root command delegates to the Repo Session package's `generate:openapi` script.
The [generator](../../packages/repo-session/src/scripts/generate-openapi.ts) writes
`docs/generated/local-http-api.openapi.json`. That derived file is ignored by
Git and exists only after generation. The Repo Session does not serve it as a
public documentation route.

## Connection and Authentication

The first-version service is an optional listener owned by a Repo Session. It
binds only to `http://127.0.0.1`; LAN access, HTTPS, IPv6,
custom hosts, and user-provided certificates are outside the accepted security
boundary. See [ADR-0018](../adr/0018-secure-versioned-local-http-adapter.md).

Every Repo Session start creates a new bearer token. Keep the endpoint and token in
memory, and send the token only as:

```http
Authorization: Bearer <token>
```

Do not place the token in a URL, cookie, browser storage, or Project Config.
All actual API requests require it.
Missing, malformed, and incorrect credentials all return the same
`unauthorized` response.

Unauthenticated CORS `OPTIONS` preflight is the sole exception. It exposes no
repository state. Actual cross-origin requests remain authenticated; the
server allows `Authorization` and `Content-Type`, does not enable credentialed
CORS, and does not emit superseded Private Network Access headers. Browser
Local Network Access permission failures are handled by the Web client.

Actual authenticated API responses use `Cache-Control: no-store`; the public
CORS preflight completes before that header middleware and is the exception.
The binary export response additionally uses download and content-integrity
headers defined across the route contract and handler.

## Connection Probe

The contract is rooted at `/api/v1`. After authenticating, the bundled Web
client starts with `GET /api/v1/watcher`. The successful response both proves
that the Repo Session is reachable and seeds the initial watcher
status displayed by the Web UI; later polling uses the same endpoint.

The Web client and Repo Session are released in lockstep, so the
protocol has no separate metadata endpoint or runtime version/capability
negotiation. The executable route and response schemas remain the source of
truth for the requests each release supports.

## Request and Empty-Result Boundaries

Request objects are strict and bounded. Unknown query or body fields are
invalid. Consult the named request schemas in `http-wire.ts` for exact limits
and defaults; the following boundaries are especially easy to confuse:

- History and Raw Save Observation queries accept an empty query and apply
  pagination defaults. Search does not: it requires at least one search field.
- Save State requires exactly one of the latest selector or a commit ref. An
  empty query and a query containing both are invalid.
- Diff requires both refs. Export requires a commit ref.
- A Manual Checkpoint requires an `application/json` request body, but the
  empty JSON object `{}` is valid and uses default checkpoint behavior. A
  missing body is not equivalent to `{}`.
- In-place restore requires its complete confirmation and expected-current
  precondition; it has no empty/default request form.

An invalid or missing request returns an error envelope. A valid request that
finds no data is different and remains a successful response: Save State can
return its `empty` variant, while History, Raw Save Observation, and Search
results can contain empty collections with no next cursor. Clients must parse
these success variants rather than treating them as transport failures.

## Success and Error Handling

JSON failures use the runtime `localHttpErrorSchema` envelope with a stable
error code and a sanitized message. The complete code vocabulary lives beside
that schema in `http-wire.ts`; route-declared HTTP status coverage lives in
`http-contract.ts`; and middleware, fallback, and exception-to-code behavior
lives in `http-app.ts`. Keeping those three links together avoids a stale
hand-maintained error table.

Authentication failure is always `401 unauthorized`. Invalid strict input,
unknown routes, unsupported methods or media types, oversized bodies, missing
commits or observations, timeouts, repository contention, restore conflicts,
unavailable runtime resources, and internal restore failures remain distinct
machine-readable cases in the executable contract. A `repository_busy`
response includes `Retry-After: 1`; other failures do not imply that repeating
a request unchanged is safe or useful.

The bundled Web client validates every JSON success response and every
non-authentication JSON error response against the runtime schemas. It treats a
`401` response as an intentionally opaque authentication failure without
parsing its error envelope. Elsewhere, malformed JSON or a shape mismatch is a
protocol failure, not an API-domain error.

## Polling Model

The first version uses polling, not SSE or WebSocket. Watcher status is a
coarse snapshot with an `observationRevision` change signal and only the latest
observation summary. It is not a lossless process-event stream or durable audit
log.

While connected and visible, the Web runtime polls watcher status. A revision
change causes it to refresh latest Save State; persistent events and Raw Save
Observations are then read through their paginated queries. A selected
historical commit remains fixed while latest-known state advances. Transient
skips and Watcher Errors may change the revision without creating durable
history.

## Mutation Retry Constraints

The protocol has no idempotency keys, and the bundled client performs one HTTP
attempt per call. Do not automatically retry Manual Checkpoint or in-place
restore merely because the connection closed or a request timed out: work that
entered History may finish even when the client did not receive its response.

For `repository_busy`, wait for the advertised `Retry-After` interval, then
refresh relevant state before deciding whether to submit the mutation again.
A repeated checkpoint can create another Raw Save Observation when
`allowUnchanged` is true. Before retrying restore, fetch latest Save State and
ask the user to confirm again against a fresh expected-current precondition.

HTTP restore writes only to the configured Watched Save; it never accepts an
arbitrary server path. A normal restore supplies the latest committed Encoded
Save hash as the `present` precondition. Restoring a currently absent file uses
the separate explicit `missing` precondition. History rechecks that condition
under its write lock before backup or overwrite, and a mismatch returns
`restore_conflict`. Export is a read-only download and does not write a Restore
Target.

## Repo Session Lifecycle

Listener startup, watcher ownership, observation scheduling, fatal versus
request-local failures, and graceful shutdown belong to the
[Repo Session architecture](../architecture/repo-session.md).
They are intentionally not duplicated in this protocol reference.
