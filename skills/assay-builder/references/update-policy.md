# Update policy

## Change classification

When `assay update` runs, it compares each managed file's current on-disk hash against the manifest hash and classifies changes into one of six categories:

| Category | Meaning | Default action |
| --- | --- | --- |
| New | Template exists in new version but not in manifest | Create the file |
| Auto-update | File hash still matches manifest hash (unchanged by user) | Overwrite with new template |
| Modified by user | File hash differs from manifest hash | Skip (preserve user changes) |
| User-deleted | File recorded in manifest but absent on disk | Skip (respect deletion) |
| Untracked-existing | File exists on disk but not in manifest | Skip |
| Force | Any of the above with `--force` flag | Overwrite regardless |

`assay check` surfaces the same hash logic as warnings (`modified by user`) and errors (`managed file missing`), so check failures predict update conflicts before you run update.

## Conflict resolution flags

- `--dry-run` — show planned changes without writing. **Always run this first.**
- `--force` — overwrite all managed files including user-modified ones. Use only with explicit user consent.
- `--skip-all` — skip all conflicts (most conservative).
- `--create-new` — write new-version templates as `.new` sidecar copies instead of overwriting, so the user can diff and merge manually.

## Protected artifacts

The following are always treated as user-owned and are never auto-overwritten:

- Frozen references under `references/frozen/`
- Analysis cards under `analyses/`
- Native Task contracts and handoffs under `tasks/`
- Knowledge documents under `knowledge/`
- Data files under `data/`
- System contract files at `systems/<name>/system.yaml` (managed metadata only; never auto-overwritten without `--force`)

System internals — `systems/<name>/README.md`, `CHANGELOG.md`, `docs/*`, source code — are **not** managed files in current layouts. The framework treats system internals as opaque; only the contract file links the system to the registry.
