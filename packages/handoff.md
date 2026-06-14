# MetaSystem Kit TypeScript Rewrite Handoff

## Background

MetaSystem Kit is a local-first toolkit for creating and maintaining framework workspaces used to study external systems, extract useful patterns, and evolve a local system safely. The current package area lives under:

```text
systems/metasystem-kit/packages/
```

The existing Python implementation has been preserved as:

```text
systems/metasystem-kit/packages/metasystem-framework-cli-python/
```

That Python package is the behavior reference for the TypeScript rewrite. It currently provides the `metasystem` CLI and owns:

- framework workspace initialization;
- structure checks and status reporting;
- managed template generation;
- manifest hashing and update safety;
- dry-run update and layout migration planning;
- reference freezing;
- analysis and iteration draft creation;
- JSONL event capture.

The rewrite should not be a line-by-line translation. It should preserve behavior while changing the architecture so future GUI code can reuse the same framework operations without shelling out to the CLI.

## Target Architecture

Create two TypeScript packages:

```text
packages/
  metasystem-framework-core/   reusable operations, schemas, templates, update logic
  metasystem-framework-cli/    Commander-based CLI adapter around core
  metasystem-framework-cli-python/  existing Python reference; keep during parity work
```

The core package is the product API. The CLI package is only an adapter.

Future GUI work should depend on `metasystem-framework-core` directly. Do not design the GUI path around executing `metasystem` as a subprocess.

## Fixed Stack Decisions

- Workspace: pnpm workspace rooted at `systems/metasystem-kit`.
- Language: TypeScript strict ESM.
- Runtime target: Node LTS; prefer Node 24 for development, keep Node 22+ compatibility if practical.
- CLI framework: Commander.
- Runtime schemas/contracts: Zod.
- Filesystem utilities: fs-extra.
- YAML parsing/writing: yaml.
- Subprocess execution: execa.
- Tests: Vitest.
- Format/lint: Biome.
- Distribution: build TypeScript to JavaScript before publishing or invoking the CLI from package `bin`.

## Compatibility Contract

The first TypeScript version must preserve the Python CLI's command surface:

```text
metasystem init <target-dir> --name <project-name> [--core <core-name>] [--git] [--force] [--create-new]
metasystem check --root <target-dir>
metasystem status --root <target-dir>
metasystem update --root <target-dir> [--dry-run] [--force | --skip-all | --create-new]
metasystem migrate-layout --root <target-dir> [--dry-run | --apply]
metasystem reference add <source-dir> <name> --root <target-dir>
metasystem analysis new <title> --root <target-dir>
metasystem iteration start <title> --root <target-dir>
metasystem event capture --kind <kind> --text <text> --root <target-dir>
```

Safety behavior must also be preserved:

- do not overwrite existing files by default;
- treat skipped existing files as user-owned unless explicitly overwritten;
- skip modified managed files by default;
- support `.new` copies;
- support dry-run update and migration planning;
- create backups before applying update/migration writes;
- respect user-deleted managed files;
- keep generated templates deterministic;
- keep manifest hashes stable across line endings.

## Core/CLI Boundary Rules

Core package rules:

- must not call `console.log`;
- must not call `process.exit`;
- must not parse raw argv;
- must return structured results, typed errors, and operation summaries;
- must expose schemas and result contracts that a GUI can reuse;
- must keep filesystem side effects explicit and testable.

CLI package rules:

- owns Commander command definitions;
- maps argv/options to core calls;
- formats core results for terminal output;
- maps typed errors to stderr and exit codes;
- contains no business behavior that a GUI would need.

## Work Package Size

Each work package below is intended to be roughly:

- Human: about 1.5–2 focused days.
- AI coding agent: about 45–90 minutes, assuming local tests are available and no unexpected repository/tooling blockers appear.

Do not split work by individual files unless an implementation blocker requires it. Split by coherent behavior and validation surface.

## Work Package 1 — Baseline Contract And Workspace Foundation

### Purpose

Create a reliable starting point for the TypeScript rewrite while keeping the Python package untouched as the reference implementation.

### Inputs

- `packages/metasystem-framework-cli-python/`
- existing Python tests and smoke scripts
- repository README and package README

### Scope

- Inspect the Python package and record the behavior contract in tests/fixtures where useful.
- Add `pnpm-workspace.yaml` and root `package.json` under `systems/metasystem-kit`.
- Add shared TypeScript, Vitest, and Biome configuration.
- Create empty package skeletons:
  - `packages/metasystem-framework-core`
  - `packages/metasystem-framework-cli`
- Configure package scripts so the workspace can run `build`, `typecheck`, `test`, `lint`, and `check`.
- Add or update ignore rules for `node_modules/`, `dist/`, coverage output, and package archives.

### Deliverables

- pnpm workspace boots successfully.
- Both TypeScript packages exist and build as empty/minimal packages.
- Python reference package remains intact.
- Initial smoke command can still run against the Python implementation.

### Validation

```powershell
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

If Python scripts still reference the old package name, record that as a compatibility item before changing them.

### Do Not

- Do not remove or rewrite Python source.
- Do not switch README quick start to TypeScript yet.
- Do not mark parity complete.

## Work Package 2 — Core Contracts, Schemas, And Low-Level Services

### Purpose

Build the reusable core foundation that all framework operations depend on. This package is the future GUI integration surface.

### Inputs

- Python modules:
  - `constants.py`
  - `paths.py`
  - `hashing.py`
  - `reporting.py`
  - `manifest.py`
  - `events.py`
- current manifest files generated by Python smoke tests

### Scope

- Define public result types for operations, reports, check rows, update plans, and typed errors.
- Define Zod schemas for:
  - framework manifest;
  - managed file records;
  - event entries;
  - operation reports;
  - update analysis/change sets.
- Port path helpers:
  - relative display path;
  - slugification;
  - framework root discovery.
- Port normalized SHA-256 hashing with cross-platform line-ending normalization.
- Port manifest load/save/record behavior with validation at read boundaries.
- Port event JSONL append behavior.

### Deliverables

- `metasystem-framework-core` exports stable contracts from `src/index.ts`.
- Core utilities are covered by unit tests.
- Manifest and event APIs return structured values, not terminal output.

### Validation

```powershell
pnpm --filter metasystem-framework-core typecheck
pnpm --filter metasystem-framework-core test
```

Required test coverage:

- slugify behavior;
- relative path display;
- root discovery;
- hash normalization;
- manifest parse/save/record roundtrip;
- JSONL event append;
- invalid manifest handling.

### Do Not

- Do not add CLI formatting here.
- Do not parse argv here.
- Do not write direct terminal output from core APIs.

## Work Package 3 — Templates And Workspace Operations

### Purpose

Port the user-visible framework creation and day-to-day workspace operations into the core package.

### Inputs

- Python modules:
  - `templates.py`
  - `scaffold.py`
- Python tests in `packages/metasystem-framework-cli-python/tests/test_cli_core.py`

### Scope

- Port template registry and template content.
- Preserve template paths, IDs, executable flags, protected flags, and deterministic output.
- Implement core operations:
  - `initFramework`;
  - `checkFramework`;
  - `getFrameworkStatus`;
  - `addReference`;
  - `createAnalysis`;
  - `startIteration`;
  - `captureEvent`.
- Return structured summaries usable by both CLI and GUI.
- Keep write semantics compatible with the Python implementation.

### Deliverables

- Core can create and inspect a framework workspace without the CLI package.
- Core can freeze references and create analysis/iteration artifacts.
- Unit/integration tests cover temporary workspace flows.

### Validation

```powershell
pnpm --filter metasystem-framework-core test
```

Required test coverage:

- init creates `.framework/VERSION` and `.framework/manifest.json`;
- init creates primary directories;
- existing files are skipped by default;
- `--force` equivalent updates managed templates;
- `--create-new` equivalent writes `.new` copies;
- check returns pass/fail rows;
- status returns counts;
- reference add copies source while ignoring common generated directories;
- analysis and iteration creation are deterministic enough for tests;
- event capture writes JSONL.

### Do Not

- Do not call Commander from core.
- Do not hard-code current working directory behavior in a way that prevents GUI callers from passing explicit roots.

## Work Package 4 — Update, Migration, And File Safety Engine

### Purpose

Port the highest-risk part of the system: managed-file update analysis, conflict handling, backups, and layout migration.

### Inputs

- Python module:
  - `updater.py`
- manifest and template behavior from Work Packages 2–3

### Scope

- Implement update analysis classifications:
  - new;
  - auto-update;
  - modified-by-user;
  - user-deleted;
  - untracked-existing;
  - unchanged.
- Implement dry-run update.
- Implement apply update conflict actions:
  - skip;
  - force;
  - create-new.
- Implement backup creation before writes.
- Implement layout migration planning.
- Implement layout migration apply behavior.
- Preserve user-deleted behavior.
- Return structured update/migration plans and summaries suitable for GUI preview.

### Deliverables

- Core update engine can run without CLI.
- Dry-run produces a structured preview.
- Apply writes only when requested and backs up relevant files.
- Migration is plan-first by default.

### Validation

```powershell
pnpm --filter metasystem-framework-core test
```

Required test coverage:

- clean managed file auto-updates;
- user-modified managed file is skipped by default;
- force overwrites modified files only when requested;
- create-new writes `.new` files;
- user-deleted managed file remains deleted;
- untracked existing file is skipped or copied to `.new` depending on action;
- dry-run performs no writes;
- backup directory contains expected files before apply;
- migration plan detects legacy references and experiments layout;
- migration apply copies rather than destructively moves.

### Do Not

- Do not use destructive deletes for migration.
- Do not weaken safety behavior to simplify the port.
- Do not hide conflicts in CLI-only text; core must expose them structurally.

## Work Package 5 — Commander CLI Adapter And Command Parity

### Purpose

Build the new TypeScript `metasystem` CLI as a thin adapter over `metasystem-framework-core`.

### Inputs

- core package from Work Packages 2–4
- Python CLI command definitions in `cli.py`
- existing README command examples

### Scope

- Add `metasystem-framework-cli` package metadata and `bin` entry.
- Build Commander program and subcommands.
- Implement CLI formatting for reports, checks, status, update summaries, migration plans, and errors.
- Implement exit-code mapping:
  - success `0`;
  - failed check / user error / runtime error non-zero as appropriate.
- Implement all compatibility commands listed in the contract section.
- Keep CLI code as argument parsing + core call + formatting only.

### Deliverables

- `metasystem` can be executed from the built TypeScript package.
- CLI output is human-readable and close enough to the Python behavior to preserve user workflows.
- CLI tests cover stdout, stderr, and exit codes.

### Validation

```powershell
pnpm --filter metasystem-framework-cli build
pnpm --filter metasystem-framework-cli test
node packages/metasystem-framework-cli/dist/cli.js --help
```

Smoke flow:

```powershell
metasystem init <tmp>\demo --name "MetaSystem Smoke"
metasystem check --root <tmp>\demo
metasystem status --root <tmp>\demo
metasystem update --root <tmp>\demo --dry-run
```

### Do Not

- Do not implement business rules in command handlers.
- Do not shell out to the Python package as the implementation.
- Do not switch repository docs to the TS CLI until parity work is complete.

## Work Package 6 — Parity Harness, Repository Checks, And Documentation

### Purpose

Prove the TypeScript rewrite is a safe replacement path and make repository-level checks/docs reflect the new architecture only after parity is established.

### Inputs

- Python reference package
- TypeScript core and CLI packages
- existing `scripts/check.ps1`
- existing `scripts/check.sh`
- repository and package READMEs

### Scope

- Build a parity harness that can generate comparable workspaces from Python and TypeScript implementations.
- Compare:
  - expected directory tree;
  - key managed template files;
  - manifest shape and managed file records;
  - update behavior for modified files;
  - user-deleted behavior;
  - dry-run update and migration behavior.
- Integrate TypeScript build/typecheck/test/lint into repository check scripts.
- Keep Python checks temporarily while the Python package remains.
- Update docs after command parity is verified:
  - root README quick start;
  - package README;
  - package split explanation;
  - GUI/core reuse note.
- Document intentional differences, if any.

### Deliverables

- A repeatable parity test/check.
- Repository check scripts include the TypeScript packages.
- README instructions are accurate for the new TS path after parity.
- Python removal remains gated and explicit.

### Validation

```powershell
.\scripts\check.ps1
```

If POSIX shell is available:

```bash
./scripts/check.sh
```

Parity validation should demonstrate:

- TS-generated workspace is structurally compatible with Python-generated workspace.
- Safety cases match Python behavior.
- CLI smoke passes through the built TypeScript CLI.

### Do Not

- Do not delete `metasystem-framework-cli-python` in this work package.
- Do not claim replacement is complete without parity evidence.
- Do not update docs ahead of verified behavior.

## Python Removal Gate

Python removal is a separate explicit decision after all of the following are true:

- TypeScript core tests pass.
- TypeScript CLI tests pass.
- CLI smoke passes.
- Repository check scripts pass.
- Python/TypeScript parity is documented.
- Existing generated framework workspace compatibility is verified.
- README and package docs point to the TS path.
- A rollback path is known.

Until then, keep:

```text
packages/metasystem-framework-cli-python/
```

## Suggested Public Exports

Core package:

```json
{
  "name": "metasystem-framework-core",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./schemas": "./dist/schemas/index.js"
  },
  "types": "./dist/index.d.ts"
}
```

CLI package:

```json
{
  "name": "metasystem-framework-cli",
  "type": "module",
  "bin": {
    "metasystem": "./dist/cli.js"
  },
  "dependencies": {
    "metasystem-framework-core": "workspace:*"
  }
}
```

## Done Means

- Two-package TypeScript workspace exists and passes checks.
- `metasystem-framework-core` exposes reusable operations and schemas.
- `metasystem-framework-cli` delegates to core only.
- Current CLI behavior and safety semantics are preserved.
- Future GUI can reuse core APIs without shelling out.
- Python reference remains until parity and explicit removal approval.
