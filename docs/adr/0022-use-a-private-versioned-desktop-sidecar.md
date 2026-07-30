# Use a private versioned process Adapter for Desktop Repo Sessions

We decided that the Desktop shell will reach the TypeScript Repo Session
Interface through a dedicated machine process rather than by parsing the
human CLI or reimplementing Repo Session behavior in Rust. The Adapter is a
private workspace application. It reuses `@silksong-git/repo-session` and does
not own History, watcher scheduling, HTTP, or repository rules.

The first process protocol uses one JSON object per line over stdin and stdout.
Every envelope carries an explicit protocol version and kind. Commands and
responses correlate with caller-provided request IDs; lifecycle events do not.
Stdout contains only protocol messages, while stderr contains fixed,
credential-free diagnostics. Unknown commands and incompatible protocol
versions fail explicitly. New event types are additive within a compatible
version and consumers ignore event types they do not understand.

One sidecar process may successfully open at most one Repo Session. Repository
switching replaces the process instead of adding session identity, close,
reopen, or multiplexing to this protocol. Opening starts reader HTTP and leaves
watching inactive, matching the public Repo Session Interface. Watcher start
and stop remain independent commands, and History queries continue over the
authenticated loopback HTTP Interface instead of becoming generic process RPC.

The session bearer credential crosses the process boundary exactly once in the
successful open response. It does not appear in command arguments, lifecycle
events, diagnostics, URLs, or persisted state. Commands execute serially.
Events produced during a command are buffered until its response is flushed,
so a caller can establish command state before handling related events.

Requested graceful shutdown is a successful shutdown response followed by exit
status zero. The response is emitted only after Repo Session shutdown has
closed admission and drained admitted HTTP and watcher work. EOF, signals,
output failure, and session-fatal failure do not produce that acknowledgment
and take a non-graceful exit path.

This decision adds a development executable and executable protocol tests. It
does not select a self-contained production packaging mechanism, configure a
Tauri external binary, or add Rust process supervision. Those delivery
concerns require the later packaging and Desktop lifecycle work.
