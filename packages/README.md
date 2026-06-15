# Packages

This monorepo contains the TypeScript framework packages:

- `metasystem-framework-core/` — reusable TypeScript operations, schemas, template registry, manifest handling, update planning, migration planning, and file-safety behavior. GUI code should depend on this package directly.
- `metasystem-framework-cli/` — Commander CLI adapter that maps argv to core calls, formats structured results, and maps known errors to exit codes.

Keep package-specific build metadata inside the package directory. Keep repository-level checks and documentation at the monorepo root.

## Validation

From the repository root:

```powershell
pnpm check
pnpm smoke
.\scripts\check.ps1
```

`pnpm smoke` runs the built TypeScript CLI through help, init, check, status, update dry-run, and migration dry-run.

## Intentional Differences

Framework behavior lives in `metasystem-framework-core`, and terminal/process concerns live in `metasystem-framework-cli`.
