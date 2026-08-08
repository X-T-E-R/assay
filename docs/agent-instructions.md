# Agent instructions

Assay may own one delimited block in `AGENTS.md`. The block states stable workspace rules and a directory table composed from fixed native resolvers plus custom `layout.entries`. It does not name or reload the one-shot Template.

`assay init` installs the block unless `--no-agents` is used. `assay update --agents` installs or refreshes it. Without `--agents`, update only refreshes an already-present valid block. Incomplete markers are never overwritten automatically.

`AGENTS.md` is not part of the managed-file receipt because content outside the delimiters remains user-owned.
