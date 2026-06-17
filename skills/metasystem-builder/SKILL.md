---
name: metasystem-builder
description: "Build, adopt, update, analyze, and iterate MetaSystem framework workspaces. Use when the user wants to initialize a MetaSystem project, adopt an existing project into MetaSystem, learn from external projects, freeze references, create analyses, evolve local systems, manage framework updates, or safely migrate old folders. Not for generic note-taking, arbitrary project scaffolding, or non-MetaSystem knowledge management workflows."
---

# MetaSystem Builder

Build and maintain a MetaSystem external-system-learning framework — a versioned project layer that stores external systems, analyzes them, converts validated patterns into our own framework, and iterates that framework over time.

## Prerequisites

- Node.js >= 18
- `metasystem` CLI built from the `metasystem-kit` monorepo (`pnpm build`)
- Read `references/cli-setup.md` for build, PATH, and invocation details

## Core loop

```text
references -> analyses -> systems -> iterations -> knowledge
```

## CLI quick reference

Prefer the CLI for all workspace operations — it preserves user files, writes a manifest, and keeps updates auditable.

```bash
metasystem init [target-dir] --name <project-name>
metasystem adopt --dry-run                        # always dry-run first
metasystem adopt --apply --name <project-name>
metasystem check
metasystem status
metasystem update --dry-run                       # always dry-run first
metasystem migrate-layout --dry-run               # always dry-run first
metasystem reference add <source-dir> <name>
metasystem analysis new "Title"
metasystem iteration start "Title"
metasystem projects list | scan | show | prune
```

For build instructions, PATH setup, and registry commands, read `references/cli-setup.md`.

## Adopt an existing project

Use `adopt` when the current directory already contains a non-MetaSystem project. Always run `--dry-run` first, review the plan, then `--apply`. The CLI archives root contents under `.old/<timestamp>/`, preserves `.git/`, and creates the standard scaffold.

For the full post-adoption workflow (inspect, analyze, confirm direction, move artifacts, validate), read `references/adoption-workflow.md`.

## Framework structure

Target projects converge to an 8-directory layout (`.framework/`, `references/`, `analyses/`, `systems/`, `iterations/`, `knowledge/`, `data/`, `releases/`). For the full structure diagram and intent-to-directory mapping, read `references/framework-structure.md`.

## Update policy

Always run `update --dry-run` before applying. User-modified files are skipped by default; use `--create-new` for sidecar copies or `--force` only with explicit user consent. For change classification rules, conflict flags, and backup behavior, read `references/update-policy.md`.

## Workflow

1. Inspect the target folder and any supplied external repository.
2. Run `init` if empty, `adopt --dry-run` then `--apply` if it has existing content, or `check`/`status` if it already has a MetaSystem manifest.
3. Use `projects list` or `projects scan <parent-dir>` to locate existing workspaces.
4. Freeze external projects with `reference add` or manually under `references/frozen/YYYYMM/`.
5. Write an analysis card under `analyses/`.
6. Convert promising findings into a candidate pattern.
7. Start an iteration against `systems/<core>/`.
8. Promote successful results into `knowledge/`, ADRs, CLI behavior, or system docs.
9. Run `update --dry-run` before applying framework upgrades.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not adopt an already initialized MetaSystem workspace; use update or migration instead.
- Do not put external project source under `systems/`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress.
- Do not silently rename or delete legacy folders.
- Do not move `.old/` content into new locations before the direction is understood and confirmed.
- Do not copy AGPL or incompatible upstream source into our skill; extract patterns and document decisions instead.
- Do not leave an external reference without an analysis exit: adopt, reject, experiment, or ADR.

## Validation

After any init, adopt, update, or migrate operation:

```bash
metasystem check
metasystem status
```

Confirm `check` reports no missing managed files and `status` shows the expected `.framework/VERSION`. For update and migrate, always run `--dry-run` first and review the plan before `--apply`.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.framework/VERSION`.
- Whether migration was only planned or applied.
- Which reference/analysis/iteration artifacts were produced.
- Next recommended adoption or iteration step.
