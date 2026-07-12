# Resolve config from built-in defaults, project config, and CLI args

We decided that configuration is resolved as an Effective Config with this precedence: CLI args override Project Config, and Project Config overrides built-in defaults. Project Config lives with a Save History Repository, for example under `.silksong-git/config.json`, so each watched save can define its own capture policy, Display Semantic Event Filters, and restore defaults.

The first config schema should stay explicit rather than introducing a rule language. It includes the watched save path, capture policy settings such as `debounceWriteMs` and `minCommitIntervalMs`, Display Semantic Event Filter fields such as hidden event types, item types, summary metrics, journal delta thresholds, and currency-only event hiding, and restore backup settings. The local HTTP host is fixed to `127.0.0.1`; its port is a runtime process binding, not a Project Config field.
