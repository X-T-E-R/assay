# MetaSystem Kit

MetaSystem Kit is a local-first toolkit for learning from external systems and turning those lessons into a versioned framework of your own.

It combines a TypeScript framework core, a Commander-based CLI, a reusable framework template, architecture decision records, and an AI-facing Skill. The core workflow is:

```text
references -> analyses -> systems -> iterations -> knowledge
```

Use it when you want to freeze external projects or documents, analyze their patterns, build your own system from the validated parts, and keep that system updatable over time.

## Repository Layout

```text
packages/metasystem-framework-core/         TypeScript reusable framework operations
packages/metasystem-framework-cli/          TypeScript Commander CLI adapter
skills/bootstrap-system-framework/   AI-facing Skill and agent metadata
examples/framework-template/         Generated example framework workspace
docs/decisions/                      ADRs and migration notes
docs/background/                     Design background and public references
scripts/                             Repository validation helpers
```

## What the Framework Creates

A managed framework workspace has this shape:

```text
.framework/   version, manifest, events, migrations, backups
references/   external systems; intake and frozen snapshots
analyses/     reference analysis, gap analysis, candidate patterns
systems/      your active framework or system implementation
iterations/   planned changes to your own framework
knowledge/    accepted reusable knowledge only
data/         samples, evaluation data, experiment inputs and outputs
releases/     release notes, packages, migration guides
```

The core package owns managed templates and update mechanics, while the CLI stays an adapter for terminal usage. User artifacts are protected by a manifest, hash checks, dry-run updates, and migration planning.

## Quick Start

Install dependencies, build the TypeScript packages, and run the CLI from the repository root:

```powershell
pnpm install
pnpm build
node packages\metasystem-framework-cli\dist\cli.js init "..\metasystem-demo" --name MetaSystem
node packages\metasystem-framework-cli\dist\cli.js check --root "..\metasystem-demo"
node packages\metasystem-framework-cli\dist\cli.js status --root "..\metasystem-demo"
```

For local development, the package scripts cover the TypeScript workspace:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
```

## Common Commands

```powershell
metasystem init <target-dir> --name <project-name>
metasystem check --root <target-dir>
metasystem status --root <target-dir>
metasystem update --root <target-dir> --dry-run
metasystem migrate-layout --root <target-dir> --dry-run
metasystem reference add <source-dir> <name> --root <target-dir>
metasystem analysis new "Reference analysis" --root <target-dir>
metasystem iteration start "CLI refactor" --root <target-dir>
```

## Validation

Use the repository check script:

```powershell
.\scripts\check.ps1
```

On a POSIX shell:

```bash
./scripts/check.sh
```

The repository check includes TypeScript build, typecheck, lint, tests, and a TypeScript CLI smoke flow that covers help, init, check, status, update dry-run, and migration dry-run.

## Package Split And GUI Reuse

- `metasystem-framework-core` owns framework operations, schemas, templates, manifest handling, update planning, migration planning, and file-safety behavior.
- `metasystem-framework-cli` is a thin Commander adapter around the core package. It parses argv, formats structured results, and maps known errors to process exit codes.
- Future GUI code should import `metasystem-framework-core` directly instead of shelling out to the CLI.

## Compatibility Notes

The TypeScript CLI is the active implementation. Its compatibility surface is the `metasystem` command set documented above and the reusable `metasystem-framework-core` API.

## Public Repository Boundary

This repository should contain reusable code, templates, documentation, and sanitized examples. Runtime logs, private external references, local absolute paths, secrets, generated packages, and one-off delivery artifacts should stay outside the repository.
