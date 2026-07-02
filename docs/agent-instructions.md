# Agent Instructions

Assay can maintain a small managed block in the workspace root `AGENTS.md`.
The block tells coding agents how to treat an Assay workspace without owning the
whole file.

- `assay init` and successful `assay adopt --apply` add or refresh the block by
  default.
- Add `--no-agents` to `init` or `adopt --apply` to skip the block.
- Ordinary `assay update` refreshes the block only when `AGENTS.md` already
  contains the Assay markers.
- `assay update --agents` creates `AGENTS.md`, appends the block to an existing
  file, or refreshes the existing block.
- If the markers are incomplete, Assay leaves `AGENTS.md` unchanged and reports
  the malformed block instead of guessing how to rewrite it.

Assay preserves all content outside:

```markdown
<!-- ASSAY:START -->
...
<!-- ASSAY:END -->
```

Do not add `AGENTS.md` to archetype templates or manifest managed-file tracking.
The block is intentionally marker-based so local repository instructions remain
owned by the workspace.
