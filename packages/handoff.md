# MetaSystem Kit package handoff

## Current package boundary

MetaSystem Kit now uses TypeScript packages as the active implementation:

```text
packages/
├── metasystem-framework-core/  # reusable framework behavior
└── metasystem-framework-cli/   # Commander CLI adapter
```

`metasystem-framework-core` owns templates, manifests, events, workspace operations, update planning/apply behavior, migration planning/apply behavior, typed errors, and structured results.

`metasystem-framework-cli` owns process-facing behavior only: command definitions, argv/options mapping, formatting, and exit-code mapping.

## Reference package removal gate

The previous reference package removal gate has been approved. The reference package is no longer part of the workspace, and helper entrypoints should use the built TypeScript CLI:

```bash
node packages/metasystem-framework-cli/dist/cli.js --help
cd <target-dir>
node <metasystem-kit>/packages/metasystem-framework-cli/dist/cli.js init --name <project-name>
node <metasystem-kit>/packages/metasystem-framework-cli/dist/cli.js check
node <metasystem-kit>/packages/metasystem-framework-cli/dist/cli.js status
node <metasystem-kit>/packages/metasystem-framework-cli/dist/cli.js update --dry-run
node <metasystem-kit>/packages/metasystem-framework-cli/dist/cli.js migrate-layout --dry-run
```

## Development checks

Run from the repository root:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
pnpm check
```

`pnpm smoke` validates the built CLI help/check path and a temporary framework workspace flow.

## Boundary rules

- Keep core free of `console.log`, `process.exit`, and raw argv parsing.
- Keep CLI handlers as parse/options → core call → formatter.
- Future GUI code should import `metasystem-framework-core` directly.
- Do not reintroduce runtime checks or skill commands that depend on the removed reference package.
