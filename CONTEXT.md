# Silksong Save History Context

This context defines the domain language for tracking Silksong save files over time, mapping raw saves into semantic progress, and indexing meaningful history outside the raw Git record.

## Language

**Encoded Save**:
The original `.dat` save file exactly as written by the game. It is the canonical artifact for restore.
_Avoid_: Raw save, binary save

**Decoded Save**:
The raw JSON/raw object produced by decoding an Encoded Save, before semantic mapping is applied. It is useful for debugging and rebuilding semantic artifacts, but is not the canonical restore source.
_Avoid_: Semantic JSON, UI state

**Mapping Data**:
Definitions that name recognized items and describe how the Semantic Core derives their state from a Decoded Save when creating a Semantic Snapshot.
_Avoid_: Project Config, Semantic Snapshot, UI data

**Semantic Snapshot**:
The full set of recognized user-meaningful item, boss, quest, journal, scene, and progress states derived from a Decoded Save and the tracker's Mapping Data at one point in time. It covers the same item data used by the Web UI plus selected Save Summary Metrics, and belongs to the Semantic Read Model, not the canonical Git history.
_Avoid_: Raw JSON, UI state

**Save State**:
The current inspection value composed of a Decoded Save and, when available, its Semantic Snapshot. In Local History workflows it is fixed to either the latest or a selected Raw Save Observation.
_Avoid_: Save Store, Raw Save Observation, Semantic Snapshot

**Save Summary Metric**:
A high-level value from the Decoded Save that summarizes the whole save rather than one mapped item, such as completion percentage, play time, rosaries, shell shards, or permadeath mode. Save Summary Metrics use semantic names rather than raw Decoded Save field names.
_Avoid_: Semantic item, raw field diff

**Semantic Event**:
A meaningful item-level state transition between two Semantic Snapshots, such as obtaining an item, defeating a boss, accepting or completing a quest, or reaching a required progress threshold. It is not a raw field diff, though it may include Source References back to the Decoded Save and Mapping Data that produced it.
_Avoid_: File diff, raw diff

**Regression Event**:
A Semantic Event where a user-meaningful state moves backward, such as `done` to `missing` or a level decreasing. It is still recorded because restore, rollback, and save replacement can produce legitimate backwards transitions.
_Avoid_: Error, invalid event

**Source Reference**:
A pointer from a Semantic Event or Semantic Snapshot item back to the Decoded Save fields and Mapping Data entries that produced it.
_Avoid_: Event, raw diff

**Raw Save Observation**:
A stable observed state of a watched save file that is committed to the Save History Repository, regardless of whether the current semantic rules consider it meaningful.
_Avoid_: Semantic commit, meaningful commit

**Unrecognized Schema Observation**:
A Raw Save Observation whose Encoded Save decoded successfully but whose Decoded Save shape cannot be identified or parsed by the current tool version. It is still committed, but does not produce Semantic Snapshots or Semantic Events until a later rebuild supports it.
_Avoid_: Corrupted save, semantic event

**Watcher Error**:
A non-committed failure observed by a Repo Session, such as a decode failure,
transient half-written file, unreadable path, or corrupted/non-save input.
_Avoid_: Raw save observation, unrecognized schema observation

**Observation Metadata**:
The metadata committed with a Raw Save Observation, including observation time, observation trigger, source path, encoded and decoded hashes, decoder version, app version, and previous observation commit.
_Avoid_: Semantic event, config

**Observation Trigger**:
The cause of a Raw Save Observation, such as the watcher observing a stable save write or the user requesting a manual checkpoint.
_Avoid_: Git commit type

**Manual Checkpoint**:
A user-requested Raw Save Observation of the current Watched Save, intended for deliberate backup points such as before a high-risk in-game action. It may bypass Capture Policy skip rules but must still decode successfully and use the repository write lock.
_Avoid_: Restore point, save copy

**Version Stamp**:
A recorded version or hash that explains which game, distribution build, save schema, platform, decoder, Mapping Data, semantic core, and effective config produced a Decoded Save, Semantic Snapshot, or Semantic Event.
_Avoid_: Display label

**Save Schema Version**:
The tool-recognized version of the Decoded Save shape. It is used to choose parser and mapping behavior when game updates change save structure or flag semantics.
_Avoid_: Game version, decoder version

**Game Version**:
The in-game displayed version of Silksong that wrote an Encoded Save, when the save exposes it or the user provides it. It is useful context but may be unavailable.
_Avoid_: Save schema version, distribution build ID

**Distribution Build ID**:
The platform-specific build identifier for the distributed game package, such as a Steam build ID. It is useful provenance for platform-specific installs but is not the same as the in-game Game Version.
_Avoid_: Game version, save schema version

**Capture Policy**:
The rules that decide which stable Raw Save Observations are committed to the Save History Repository. It controls raw history fidelity and is separate from semantic display filtering.
_Avoid_: Semantic filter, display filter

**Minimum Commit Interval**:
A Capture Policy setting that limits how frequently Raw Save Observations are committed. When multiple stable save changes occur inside the interval, only the latest observation is committed.
_Avoid_: Debounce, semantic filter

**Effective Config**:
The resolved configuration used by a command or local Web UI session after applying built-in defaults, Project Config, and CLI argument overrides.
_Avoid_: Config file

**Project Config**:
The configuration stored with a Save History Repository for one watched save, including capture policy, display event filters, and restore defaults.
_Avoid_: Effective config

**Save History Repository**:
A local Git repository created for one watched save file. It stores Raw Save Observations made of Encoded Saves, Decoded Saves, and observation metadata for durable history and restore workflows.
_Avoid_: Backup folder, cache

**Watched Save**:
The single local `.dat` save file tracked by one Save History Repository.
_Avoid_: Save slot, save group

**Restore Target**:
The filesystem path where an Encoded Save from a selected commit is written during restore. It must be explicit unless the user chooses in-place restore.
_Avoid_: Watched save, history repo

**In-Place Restore**:
A restore operation that overwrites the Watched Save path from Project Config. It requires explicit user intent and creates a backup before writing.
_Avoid_: Default restore

**Repo Session**:
The long-running local runtime for one Save History Repository. It acquires one
Save History Watcher lease, owns file-event scheduling and optional local HTTP,
and calls public History workflows. In the current lifecycle, starting a Repo
Session always acquires watcher ownership; it is not yet a query-only or
watcher-independent session.
_Avoid_: Web UI server, frontend server, History Module

**Offline Command**:
A CLI command that reads the Save History Repository and Semantic Read Model directly without requiring a Repo Session to be running.
_Avoid_: Watcher

**Static Web Mode**:
The browser-only mode of the Web UI where a user uploads an Encoded Save or Decoded Save and views the current tracker state without Git, SQLite, or local filesystem access.
_Avoid_: Local history mode

**Local History Web Mode**:
The Web UI mode enabled when the frontend is connected to compatible local HTTP endpoints for watcher status, history, semantic diff, search, and restore/export workflows.
_Avoid_: Static web mode

**Semantic Read Model**:
A rebuildable SQLite-backed index of Semantic Snapshots, the complete set of Semantic Events, event-to-commit lookup data, display event filter metadata, and mapper versions derived from the Save History Repository. Display filtering is applied at query time, not by deleting events from this model.
_Avoid_: Canonical history, Git history

**Display Semantic Event Filter**:
A user-configurable rule that controls which Semantic Events are visible in default CLI/UI history views, notifications, and meaningful-history queries. It does not decide which Raw Save Observations are committed.
_Avoid_: Capture policy, Git filter
