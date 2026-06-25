# Commit decoded observations even when the save schema is unrecognized

We decided that when an Encoded Save decodes successfully but the current parser cannot identify or parse its Save Schema Version, the watcher still commits the Raw Save Observation with `save.dat`, `decoded-save.json`, and `observation.json` marked as an unrecognized schema observation. It does not generate Semantic Snapshots or Semantic Events until a future tool version supports that shape and `rebuild` is run.

This preserves raw history across game updates without pretending the current semantic mapper understands unknown save structures.

Decode failures are different: if bytes cannot be decoded into a Decoded Save at all, the watcher records a Watcher Error and does not commit. These failures usually represent half-written files, corrupted input, wrong paths, or non-save files, and committing them would pollute restoreable Git history.
