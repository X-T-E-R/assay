# Assay

**Study many. Grow your own.**

A CLI workbench for the systems, tools, and workflows you're tempted to borrow from — freeze them as references, assay them through evaluation lenses, then distill the patterns worth keeping into your own.

It combines a TypeScript framework core, a Commander-based CLI, a reusable framework template, architecture decision records, and an AI-facing Skill. The core workflow is:

```text
references -> analyses -> systems -> iterations -> knowledge
```

Use it when you want to freeze external projects or documents, assay their patterns, build your own system from the validated parts, and keep that system updatable over time.

## Repository Layout

```text
packages/assay-core/         TypeScript reusable framework operations
packages/assay-cli/          TypeScript Commander CLI adapter
skills/assay-builder/           AI-facing Skill and agent metadata
examples/framework-template/         Generated example framework workspace
docs/background/                     Design background and public references
scripts/                             Repository validation helpers
```

Framework evolution decisions (ADRs) live under `.framework/decisions/` and are
local governance artifacts, not version-controlled in this repository.

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
mkdir ..\assay-demo
cd ..\assay-demo
assay init --name Assay
assay check
assay status
```

For repository-local development without a global `assay` command, run the
built CLI from the target workspace:

```powershell
mkdir ..\assay-demo
cd ..\assay-demo
node ..\assay\packages\assay-cli\dist\cli.js init --name Assay
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
assay init --name <project-name>
assay adopt --dry-run
assay adopt --apply --name <project-name>
assay check
assay status
assay update --dry-run
assay projects list
assay projects scan <parent-dir>
assay migrate-layout --dry-run
assay reference add <source-dir> <name>
assay analysis new "Reference analysis"
assay iteration start "CLI refactor"
```

Run these commands from the framework workspace by default. Use
`assay init <target-dir>` or `--root <target-dir>` only when operating on a
workspace from another directory.

## Adopting Existing Projects

Use `adopt` when the current directory already contains an ordinary project and
you want a clean Assay root:

```powershell
cd C:\path\to\existing-project
assay adopt --dry-run
assay adopt --apply --name ExistingProject
```

The apply step archives current root contents under a timestamped `.old/`
directory, keeps `.git/` at the root, creates a new Assay scaffold, and
writes an adoption manifest into the archive. After that, inspect `.old/<stamp>/`
and move archived content into the appropriate new project locations only after
the target direction is clear.

`assay init` and successful `assay update` runs register the scaffolded
workspace in a user-local project registry under `~/.assay/projects`.
Use `assay projects list` to find known framework workspaces,
`assay projects show <id-or-path>` to inspect one record, and
`assay projects prune --dry-run` to preview cleanup of missing registry
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

- `assay-core` owns framework operations, schemas, templates, manifest handling, update planning, migration planning, and file-safety behavior.
- `assay-cli` is a thin Commander adapter around the core package. It parses argv, formats structured results, and maps known errors to process exit codes.
- Future GUI code should import `assay-core` directly instead of shelling out to the CLI.

## Compatibility Notes

The TypeScript CLI is the active implementation. Its compatibility surface is the `assay` command set documented above and the reusable `assay-core` API.

## Public Repository Boundary

This repository should contain reusable code, templates, documentation, and sanitized examples. Runtime logs, private external references, local absolute paths, secrets, generated packages, and one-off delivery artifacts should stay outside the repository.
