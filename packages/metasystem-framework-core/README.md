# metasystem-framework-core

Reusable TypeScript operations for MetaSystem framework workspaces.

This package owns framework behavior that can be shared by CLI and future GUI adapters:

- workspace initialization, checks, status, references, analyses, iterations, and event capture;
- manifest schemas and managed-file records;
- deterministic template registry;
- update planning/apply behavior, backups, user-deleted handling, and layout migration planning;
- typed errors and structured operation results.

The core package must stay free of process concerns: no argv parsing, terminal output, or process exits. GUI code should import this package directly instead of shelling out to the CLI.

## Development

```powershell
pnpm --filter metasystem-framework-core build
pnpm --filter metasystem-framework-core typecheck
pnpm --filter metasystem-framework-core test
```

The Python reference package remains in `../metasystem-framework-cli-python/` until an explicit removal gate is approved.
