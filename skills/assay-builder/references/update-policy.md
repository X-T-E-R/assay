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
| Unchanged | File already matches the current fixed core content | Keep it and reconcile a stale or missing receipt record when needed |

`assay check` surfaces the same hash logic as warnings (`modified by user`) and errors (`managed file missing`), so check failures predict update conflicts before you run update.

## Conflict resolution flags

- `--dry-run` — show planned changes without writing. **Always run this first.**
- `--force` — overwrite conflicting user-modified or untracked managed files, except protected receipt entries. It does not recreate user-deleted files. Use only with explicit user consent.
- `--skip-all` — skip all conflicts (most conservative).
- `--create-new` — write new-version templates as exact `<target>.new` sidecar copies instead of overwriting, so the user can diff and merge manually. If any planned sidecar already exists, update refuses before any ordinary update write and preserves it byte-for-byte; it never overwrites or invents suffixed names.

Ordinary update writes managed files, the managed AGENTS block, and `.new` sidecars through recoverable compare-and-swap transactions. Successful writes and recovered crash windows clean their transient transaction artifacts. They do not create retained timestamp backups or return a backup result, and existing `.assay/backups/` entries remain untouched. Update also does not recreate deleted Project README or Roadmap guide files.

## Protected artifacts

The following are user-owned and outside the fixed-core update set:

- Frozen Sources under `sources/`
- Analysis cards under `analyses/`
- Native Task contracts and handoffs under `tasks/`
- Knowledge documents under `knowledge/`
- Data files under `data/`

System internals — `systems/<name>/README.md`, `CHANGELOG.md`, `docs/*`, and source code — are **not** managed files in current layouts. The framework treats System internals as opaque; only the schema-3 registry records Project-local membership and locators.

For fixed-core receipt entries, `protected: true` prevents `--force` from overwriting a conflicting modified or untracked file. A protected file that still matches its recorded baseline remains eligible for the ordinary generated-version refresh.
