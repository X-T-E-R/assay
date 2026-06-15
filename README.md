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
skills/metasystem-builder/           AI-facing Skill and agent metadata
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

Install dependencies and build the TypeScript packages from this repository:

```powershell
pnpm install
pnpm build
```

Then use the CLI from the framework workspace you want to create or manage:

```powershell
mkdir ..\metasystem-demo
cd ..\metasystem-demo
metasystem init --name MetaSystem
metasystem check
metasystem status
```

For repository-local development without a global `metasystem` command, run the
built CLI from the target workspace:

```powershell
mkdir ..\metasystem-demo
cd ..\metasystem-demo
node ..\metasystem-kit\packages\metasystem-framework-cli\dist\cli.js init --name MetaSystem
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
metasystem init --name <project-name>
metasystem adopt --dry-run
metasystem adopt --apply --name <project-name>
metasystem check
metasystem status
metasystem update --dry-run
metasystem projects list
metasystem projects scan <parent-dir>
metasystem migrate-layout --dry-run
metasystem reference add <source-dir> <name>
metasystem analysis new "Reference analysis"
metasystem iteration start "CLI refactor"
```

Run these commands from the framework workspace by default. Use
`metasystem init <target-dir>` or `--root <target-dir>` only when operating on a
workspace from another directory.

## Adopting Existing Projects

Use `adopt` when the current directory already contains an ordinary project and
you want a clean MetaSystem root:

```powershell
cd C:\path\to\existing-project
metasystem adopt --dry-run
metasystem adopt --apply --name ExistingProject
```

The apply step archives current root contents under a timestamped `.old/`
directory, keeps `.git/` at the root, creates a new MetaSystem scaffold, and
writes an adoption manifest into the archive. After that, inspect `.old/<stamp>/`
and move archived content into the appropriate new project locations only after
the target direction is clear.

`metasystem init` and successful `metasystem update` runs register the scaffolded
workspace in a user-local project registry under `~/.metasystem/projects`.
Use `metasystem projects list` to find known framework workspaces,
`metasystem projects show <id-or-path>` to inspect one record, and
`metasystem projects prune --dry-run` to preview cleanup of missing registry
entries. These commands manage registry metadata only; they do not delete
project files.

## Validation

Use the repository check script:

```powershell
.\scripts\check.ps1
```

On a POSIX shell:

```bash
./scripts/check.sh
```

The repository check includes TypeScript build, typecheck, lint, tests, and a TypeScript CLI smoke flow that covers help, init, adopt dry-run/apply, check, status, update dry-run, project registry listing, and migration dry-run.

## Package Split And GUI Reuse

- `metasystem-framework-core` owns framework operations, schemas, templates, manifest handling, update planning, migration planning, and file-safety behavior.
- `metasystem-framework-cli` is a thin Commander adapter around the core package. It parses argv, formats structured results, and maps known errors to process exit codes.
- Future GUI code should import `metasystem-framework-core` directly instead of shelling out to the CLI.

## Compatibility Notes

The TypeScript CLI is the active implementation. Its compatibility surface is the `metasystem` command set documented above and the reusable `metasystem-framework-core` API.

## Public Repository Boundary

This repository should contain reusable code, templates, documentation, and sanitized examples. Runtime logs, private external references, local absolute paths, secrets, generated packages, and one-off delivery artifacts should stay outside the repository.
