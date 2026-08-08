# Update policy

## Change classification

When `assay update` runs, it compares each fixed core file's current on-disk hash against its baseline in `.assay/managed-files.json` and classifies changes into one of six categories:

| Category | Meaning | Default action |
| --- | --- | --- |
| New | Current fixed core contains a managed path absent from the installed receipt and disk | Create the file |
| Auto-update | File hash still matches the managed baseline (unchanged by user) | Write the current fixed core content |
| Modified by user | File hash differs from the managed baseline | Skip (preserve user changes) |
| User-deleted | File is recorded in the managed receipt but absent on disk | Skip (respect deletion) |
| Untracked-existing | A current managed path exists on disk but is absent from the installed receipt | Skip |
| Force | Any of the above with `--force` flag | Overwrite regardless |

`assay check` surfaces the same hash logic as warnings (`modified by user`) and errors (`managed file missing`), so check failures predict update conflicts before you run update.

## Conflict resolution flags

- `--dry-run` — show planned changes without writing. **Always run this first.**
- `--force` — overwrite all managed files including user-modified ones. Use only with explicit user consent.
- `--skip-all` — skip all conflicts (most conservative).
- `--create-new` — write new-version templates as `.new` sidecar copies instead of overwriting, so the user can diff and merge manually.

## Protected artifacts

The following are always treated as user-owned and are never auto-overwritten:

- Frozen Sources under `sources/`
- Analysis cards under `analyses/`
- Native Task contracts and handoffs under `tasks/`
- Knowledge documents under `knowledge/`
- Data files under `data/`

System internals — `systems/<name>/README.md`, `CHANGELOG.md`, `docs/*`, and source code — are **not** managed files in current layouts. The framework treats System internals as opaque; only the schema-3 registry records Project-local membership and locators.
