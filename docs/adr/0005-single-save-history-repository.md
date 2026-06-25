# Use one save history repository per watched save

We decided that the first version uses one Save History Repository for one Watched Save. This keeps restore behavior, Project Config, watcher operation, Semantic Snapshots, and Semantic Events focused on a single save file; users with multiple save files can create multiple repositories, and a later workspace or aggregate index can be added only if multi-save workflows prove necessary.
