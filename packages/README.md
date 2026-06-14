# Packages

This monorepo contains the TypeScript framework packages plus the preserved Python reference package:

- `metasystem-framework-core/` — reusable TypeScript operations, schemas, template registry, manifest handling, update planning, migration planning, and file-safety behavior. GUI code should depend on this package directly.
- `metasystem-framework-cli/` — Commander CLI adapter that maps argv to core calls, formats structured results, and maps known errors to exit codes.
- `metasystem-framework-cli-python/` — preserved Python CLI reference used for parity checks and rollback until a separate removal gate is approved.

Keep package-specific build metadata inside the package directory. Keep repository-level checks and documentation at the monorepo root.

## Validation

From the repository root:

```powershell
pnpm check
pnpm parity
.\scripts\check.ps1
```

`pnpm parity` compares the Python and TypeScript implementations for generated workspace structure, key managed template files, manifest records, update safety, user-deleted files, update dry-runs, and migration dry-run/apply behavior.

## Intentional Differences

No functional differences are currently intended for the parity-covered command behavior. The TypeScript implementation intentionally differs architecturally: framework behavior lives in `metasystem-framework-core`, and terminal/process concerns live in `metasystem-framework-cli`.
