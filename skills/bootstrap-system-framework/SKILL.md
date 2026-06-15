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

Default terminal usage follows normal project habits: enter the directory you
want to manage, then run `init` or other commands without passing a path.

```bash
mkdir -p <target-dir>
cd <target-dir>
metasystem init --name <project-name>
metasystem adopt --dry-run
metasystem adopt --apply --name <project-name>
metasystem check
metasystem status
metasystem update --dry-run
metasystem migrate-layout --dry-run
metasystem reference add <source-dir> <name>
metasystem analysis new "Reference analysis"
metasystem iteration start "CLI refactor"
metasystem projects list
metasystem projects scan <parent-dir>
```

Use `metasystem init <target-dir>` or `--root <target-dir>` only when operating
on a workspace from another directory. For repository-local development before a
global command is installed, build the package and invoke the compiled CLI by
absolute or relative path from the target workspace.

The CLI tracks initialized framework workspaces in a user-local registry at
`~/.metasystem/projects`. Use `projects list` to locate known scaffolded
workspaces, `projects show <id-or-path>` to inspect one, `projects scan` to
discover existing workspaces by `.framework/manifest.json`, and
`projects prune --dry-run` before removing stale registry records. These
commands remove only registry metadata, never project files.

## Adopt an existing project

Use `adopt` when the current directory already contains a non-MetaSystem project
and the user wants to rebuild it as a clean MetaSystem workspace.

```bash
cd <existing-project>
metasystem adopt --dry-run
metasystem adopt --apply --name <project-name>
metasystem check
metasystem status
```

Adoption archives existing root contents under `.old/<timestamp>/`, preserves
`.git/` at the project root, then creates the standard MetaSystem scaffold. The
archive is a staging source, not the final organization.

After adoption:

1. Inspect `.old/<timestamp>/` and its adoption manifest.
2. Write or update an adoption analysis describing what each meaningful old
   artifact is and where it should live now.
3. Confirm the target direction when the mapping changes project structure,
   build behavior, public docs, or user-facing semantics.
4. Move old artifacts into the appropriate new locations after the direction is
   clear. Do not default to copying, and do not assume every artifact belongs in
   one fixed directory.
5. Run `metasystem check` and any project-specific validation after moves.

Do not delete `.old/<timestamp>/` until the user explicitly accepts the migrated
structure or a separate cleanup task is created.

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
2. Run `init` if the target is empty/new, `adopt --dry-run` then
   `adopt --apply` if the target already has ordinary project content, or
   `check`/`status` if it already has a MetaSystem manifest.
3. Use `projects list` or `projects scan <parent-dir>` when you need to locate
   existing MetaSystem scaffolded workspaces.
4. Freeze external projects with `reference add` or manually under `references/frozen/YYYYMM/`.
5. Write an analysis card under `analyses/`.
6. Convert promising findings into a candidate pattern.
7. Start an iteration against our own `systems/<core>/`.
8. Promote successful results into `knowledge/`, ADRs, CLI behavior, or system docs.
9. Run `update --dry-run` before applying framework upgrades.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not adopt an already initialized MetaSystem workspace; use update or
  migration commands instead.
- Do not put external project source under `systems/`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress.
- Do not silently rename/delete legacy folders.
- Do not move archived `.old/` content into new locations before the direction
  is understood and confirmed when necessary.
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
