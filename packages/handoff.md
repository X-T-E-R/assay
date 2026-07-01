# Assay package boundary notes

This note preserves durable package-boundary facts for maintainers of Assay
itself. Keep release-facing docs aligned with the current Assay package names
and CLI entrypoints; do not reintroduce older project or package names here.

## Active package split

```text
packages/
├── assay-core/  # reusable framework behavior
└── assay-cli/   # Commander CLI adapter
```

- `assay-core` owns templates, manifests, events, workspace operations,
  update/migration planning, typed errors, and structured results.
- `assay-cli` owns process-facing behavior only: command definitions,
  argv/options mapping, terminal formatting, and exit-code mapping.

## Invocation and checks

Use the built TypeScript CLI:

```bash
node packages/assay-cli/dist/cli.js --help
node packages/assay-cli/dist/cli.js init --name <project-name>
node packages/assay-cli/dist/cli.js source add <repo-or-dir> [alias]
node packages/assay-cli/dist/cli.js check
node packages/assay-cli/dist/cli.js status
node packages/assay-cli/dist/cli.js update --dry-run
node packages/assay-cli/dist/cli.js migrate-layout --dry-run
```

Run repository verification from the Assay root:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
pnpm check
```

## Boundary rules

- Keep `assay-core` free of `console.log`, `process.exit`, and raw argv
  parsing.
- Keep CLI handlers as `parse/options -> core call -> formatter`.
- Future GUI code should import `assay-core` directly.
- Do not publish release-facing docs that mention stale package names, private
  handoff prompts, or local machine paths.
