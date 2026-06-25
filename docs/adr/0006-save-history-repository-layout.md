# Use a small raw-observation repository layout

We decided that a Save History Repository worktree stores the current commit's `save.dat`, `decoded-save.json`, and `observation.json`, plus `.silksong-history/config.json` for Project Config. `observation.json` includes raw-observation metadata and Version Stamps such as `decoderVersion`. The SQLite Semantic Read Model lives at `.silksong-history/read-model.sqlite` by default but is ignored by Git, because it can be rebuilt from the raw observation commits.

Commit messages are generated from the Raw Save Observation time and may include a best-effort semantic summary when the mapper is available, but commit messages are not a source of truth and must not be parsed for history, diff, or reverse lookup features. Those features query the Semantic Read Model.
