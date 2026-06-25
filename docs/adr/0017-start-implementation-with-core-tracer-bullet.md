# Start implementation with a core semantic tracer bullet

We decided that implementation should start with a TDD tracer bullet in `packages/core`, before building CLI, watcher, history persistence, or Web history views. The first behavior should prove that a decoded save fixture and mapping fixture can produce a Semantic Snapshot for a scene-scoped collected item through the public core interface.

After that vertical slice is green, later slices can add core diffing, history raw observation and restore behavior, CLI `snapshot --json`, and Web reuse of the core snapshot result.
