# Model semantic events as item-level state transitions

We decided that a Semantic Event represents one user-understandable item-level state transition, not one raw save-field change. This makes history, semantic diff output, and reverse lookup from gameplay events to commits queryable without exposing users to `playerData`, scene flags, or saved-data internals, while still allowing each event to keep Source References for debugging and mapper rebuilds.
