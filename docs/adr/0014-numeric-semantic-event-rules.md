# Generate numeric semantic events from meaningful state transitions

We decided that numeric semantic diffing records item-level state transitions rather than every raw numeric field change as equally important. Threshold-based items produce default-visible events when they cross meaningful thresholds, such as a journal entry reaching its required kill count or a level/stage item advancing; summary metrics such as play time, rosaries, shell shards, and completion percentage may still be recorded as complete Semantic Events but are hidden by default through Display Semantic Event Filters.

Currency-only changes are hidden by default, while item stage changes such as needle upgrades produce events for each stage crossing. Backwards transitions are also recorded as Regression Events, because restore, rollback, and save replacement can legitimately move a save from `done` to `missing` or from a higher numeric state to a lower one.
