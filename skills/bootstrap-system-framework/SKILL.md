---
name: bootstrap-system-framework
description: "Bootstrap, update, analyze, and iterate an external-system-learning framework. Use when the user wants to learn from external projects, freeze references, analyze them, build a local framework, iterate the local framework, introduce version/update mechanics, safely migrate old folders, or run the bundled engineering-grade CLI."
---

# Bootstrap System Framework

This skill builds an external-system-learning framework. The framework is not a generic notes folder: it is a versioned project layer that stores external systems, analyzes them, converts validated patterns into our own framework, and iterates that framework over time.

Core loop:

```text
references → analyses → systems → iterations → knowledge
```

## Use the bundled CLI first

Prefer the bundled CLI because it preserves user files, writes a manifest, and keeps update behavior auditable.

Direct monorepo usage:

```bash
pnpm install
pnpm build
node packages/metasystem-framework-cli/dist/cli.js init <target-dir> --name <project-name>
node packages/metasystem-framework-cli/dist/cli.js check --root <target-dir>
node packages/metasystem-framework-cli/dist/cli.js status --root <target-dir>
node packages/metasystem-framework-cli/dist/cli.js update --root <target-dir> --dry-run
node packages/metasystem-framework-cli/dist/cli.js migrate-layout --root <target-dir> --dry-run
node packages/metasystem-framework-cli/dist/cli.js reference add <source-dir> <name> --root <target-dir>
node packages/metasystem-framework-cli/dist/cli.js analysis new "Reference analysis" --root <target-dir>
node packages/metasystem-framework-cli/dist/cli.js iteration start "CLI refactor" --root <target-dir>
```

## Required framework structure

Target projects should converge to:

```text
<project-root>/
├── .framework/       # version, manifest, events, migrations, backups
├── references/       # external systems; intake + frozen snapshots
├── analyses/         # reference analysis, gap analysis, candidate patterns
├── systems/          # our active framework/system implementation
├── iterations/       # iterations on our own framework
├── knowledge/        # accepted reusable knowledge only
├── data/             # samples, evaluation data, research data
└── releases/         # release notes, packages, migration guides
```

Primary mapping:

| User intent | Directory |
| --- | --- |
| store others' projects/materials | `references/` |
| analyze them | `analyses/` |
| build our own framework | `systems/` |
| iterate our own framework | `iterations/` |

## Version and update rules

The CLI writes:

- `.framework/VERSION` — installed framework template version.
- `.framework/manifest.json` — managed file manifest with template IDs and hashes.
- `.framework/events/YYYY-MM.jsonl` — auditable events.
- `.framework/backups/` — update/migration backups.

Update policy:

1. New managed templates may be created.
2. Managed files whose current hash still matches the manifest hash may auto-update.
3. Managed files changed by the user are skipped by default.
4. Use `--create-new` to write new templates as `.new` copies.
5. Use `--force` only with explicit user consent.
6. Frozen references, analyses, iterations, knowledge, and data are protected user artifacts.
7. Breaking layout moves require `migrate-layout --apply`; default is dry-run.

## Workflow

1. Inspect the target folder and any supplied external repository.
2. Run `init` if the target is new, or `check`/`status` if it already exists.
3. Freeze external projects with `reference add` or manually under `references/frozen/YYYYMM/`.
4. Write an analysis card under `analyses/`.
5. Convert promising findings into a candidate pattern.
6. Start an iteration against our own `systems/<core>/`.
7. Promote successful results into `knowledge/`, ADRs, CLI behavior, or system docs.
8. Run `update --dry-run` before applying framework upgrades.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not put external project source under `systems/`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress.
- Do not silently rename/delete legacy folders.
- Do not copy AGPL or incompatible upstream source into our skill; extract patterns and document decisions instead.
- Do not leave an external reference without an analysis exit: adopt, reject, experiment, or ADR.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.framework/VERSION`.
- Whether migration was only planned or applied.
- Which reference/analysis/iteration artifacts were produced.
- Next recommended adoption or iteration.
