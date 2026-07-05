# Contributing

Assay should stay reusable and publishable. Keep changes focused on the CLI, core package, Skill, framework templates, architecture decisions, docs, and sanitized examples.

## Repository Map

```text
packages/assay-core/          framework operations, schemas, templates, update, migration
packages/assay-cli/           Commander CLI adapter over assay-core
skills/assay-builder/         agent-facing Skill that calls this repo's CLI
examples/framework-template/  sanitized generated workspace
docs/                         command docs, workspace docs, background, and decisions
scripts/                      validation, smoke, and install helpers
```

`assay-core` owns behavior: manifests, templates, hashing, workspace operations, update planning, migration, and typed errors. The CLI should parse options, call core APIs, format output, and map exit codes.

## Local Development

Install dependencies and build:

```bash
pnpm install
pnpm build
```

Useful checks while editing:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
```

Run the full repository check before committing:

```bash
./scripts/check.sh
```

On Windows PowerShell:

```powershell
.\scripts\check.ps1
```

The full check runs build, typecheck, lint, tests, and a CLI smoke flow covering help, init, adopt dry-run/apply, check, status, update dry-run, project listing, and migration dry-run.

## Public Boundary

Do not commit:

- real external-system snapshots, private references, customer or project data, generated releases, or runtime logs;
- `.env` files, API keys, tokens, credentials, or local absolute paths;
- one-off delivery reports, temporary validation output, caches, or compiled artifacts;
- runtime contents under `.assay/backups/`, `.assay/events/`, or `.assay/.runtime/`.

Use sanitized examples when a workflow needs demonstration data. Public docs should explain product behavior and reader actions, not private context, temporary acceptance criteria, or implementation diary notes.
