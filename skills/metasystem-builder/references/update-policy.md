# Update policy

## Change classification

When `metasystem update` runs, it compares each managed file's current on-disk hash against the manifest hash and classifies changes into one of six categories:

| Category | Meaning | Default action |
| --- | --- | --- |
| New | Template exists in new version but not in manifest | Create the file |
| Auto-update | File hash still matches manifest hash (unchanged by user) | Overwrite with new template |
| Modified by user | File hash differs from manifest hash | Skip (preserve user changes) |
| User-deleted | File recorded in manifest but absent on disk | Skip (respect deletion) |
| Untracked-existing | File exists on disk but not in manifest | Skip |
| Force | Any of the above with `--force` flag | Overwrite regardless |

## Conflict resolution flags

- `--dry-run` — show planned changes without writing. **Always run this first.**
- `--force` — overwrite all managed files including user-modified ones. Use only with explicit user consent.
- `--skip-all` — skip all conflicts (most conservative).
- `--create-new` — write new-version templates as `.new` sidecar copies instead of overwriting, so the user can diff and merge manually.

## Protected artifacts

The following are always treated as user-owned and are never auto-overwritten:

- Frozen references under `references/frozen/`
- Analysis cards under `analyses/`
- Iteration plans under `iterations/`
- Knowledge documents under `knowledge/`
- Data files under `data/`

## Layout migration

Breaking directory-layout changes require `metasystem migrate-layout`. The default is `--dry-run` (plan only). Use `--apply` only after reviewing the plan. The migration uses a copy-first strategy: files are copied to new locations before the old paths are removed.

## Backup

Before any write operation during `update` or `migrate-layout --apply`, the CLI creates a timestamped backup under `.framework/backups/`. Backups are the safety net for rollback.
