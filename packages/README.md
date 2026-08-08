# Packages

This monorepo contains the TypeScript framework packages:

- `assay-core/` — reusable TypeScript operations, schemas, Template expansion, manifest and managed-receipt handling, workspace conversion, update planning, and file-safety behavior. GUI code should depend on this package directly.
- `assay-cli/` — Commander CLI adapter that maps argv to core calls, formats structured results, and maps known errors to exit codes.

The repository and the distributable `assay-core`/`assay-cli` packages require
Node.js >=22.13.0. Repository commands use the pinned pnpm 11.3.0.

Keep package-specific build metadata inside the package directory. Keep repository-level checks and documentation at the monorepo root.

## Package Boundaries

- `assay-core` owns Templates, manifests, managed receipts, events, workspace operations and conversion, update planning, typed errors, and structured results.
- `assay-cli` owns process-facing behavior only: command definitions, argv/options mapping, terminal formatting, and exit-code mapping.
- Keep `assay-core` free of `console.log`, `process.exit`, and raw argv parsing.
- Keep CLI handlers shaped as `parse options -> call core -> format result`.
- Future GUI code should import `assay-core` directly instead of shelling out to the CLI.

After building, invoke the CLI through the compiled entrypoint when testing package boundaries:

```powershell
node packages/assay-cli/dist/cli.js --help
node packages/assay-cli/dist/cli.js init --name <project-name>
node packages/assay-cli/dist/cli.js source add <repo-or-dir> [alias]
node packages/assay-cli/dist/cli.js check
node packages/assay-cli/dist/cli.js status
node packages/assay-cli/dist/cli.js update --dry-run
```

## Validation

From the repository root:

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm check
pnpm smoke
.\scripts\check.ps1
```

`pnpm smoke` runs the built TypeScript CLI through help, init, check, status, update dry-run, Source adoption, and other representative current commands.
