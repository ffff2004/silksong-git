# Require an explicit restore target unless in-place restore is requested

We decided that restore writes an Encoded Save from a selected commit to an explicit Restore Target by default, for example `restore <commit> --to path`. Overwriting the Watched Save requires an explicit in-place restore mode, reads the Watched Save path from Project Config, and creates a backup before writing, because save-file overwrite is the highest-risk operation in the product.
