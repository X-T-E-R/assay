---
name: metasystem-builder
description: "Build, adopt, update, analyze, and iterate MetaSystem framework workspaces. Use when the user wants to initialize a MetaSystem project, adopt an existing project into MetaSystem, learn from external projects, freeze references, create analyses, evolve local systems, register independently-version-controlled systems, promote or archive active systems, close iterations or analyses, add knowledge entries, manage framework updates, or safely migrate old folders. Not for generic note-taking, arbitrary project scaffolding, or non-MetaSystem knowledge management workflows."
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

Each transition has a CLI command and writes an event to `.framework/events/YYYY-MM.jsonl`. Open work is closed explicitly: iterations and analyses must be closed with a result/exit, and durable findings flow into `knowledge/`.

## CLI quick reference

Prefer the CLI for all workspace operations — it preserves user files, writes a manifest, and keeps updates auditable.

```bash
# Workspace lifecycle
metasystem init [target-dir] --name <project-name>
metasystem adopt --dry-run                        # always dry-run first
metasystem adopt --apply --name <project-name>
metasystem check                                  # semantic + structural validation
metasystem status                                 # systems + open iterations + knowledge counts
metasystem update --dry-run                       # always dry-run first
metasystem migrate-layout --dry-run               # always dry-run first; v2→v3 included

# Reference / analysis / iteration / knowledge
metasystem reference add <source-dir> <name>
metasystem analysis new "Title"
metasystem analysis close <path> --exit adopt|reject|experiment|adr
metasystem iteration start "Title"
metasystem iteration close <selector> --result applied|rejected|retest [--note ...]
metasystem knowledge add <type> "Title" [--from-analysis <path>] [--from-iteration <path>]

# System registry (layout v3+)
metasystem system register <path> [--vcs independent-git|embedded|none] [--primary] [--supersedes <names>]
metasystem system promote <selector>
metasystem system archive <selector> --dry-run | --apply
metasystem system list [--status primary|active|superseded|archived] [--json]
metasystem system show <selector>

# Project registry
metasystem projects list | scan | show <selector> | forget <selector> | prune
```

For build instructions, PATH setup, and registry commands, read `references/cli-setup.md`. For lifecycle close semantics, read `references/lifecycle-commands.md`.

## Adopt an existing project

Use `adopt` when the current directory already contains a non-MetaSystem project. Always run `--dry-run` first, review the plan, then `--apply`. The CLI archives root contents under `.old/<timestamp>/`, preserves `.git/`, and creates the standard scaffold.

For the full post-adoption workflow (inspect, analyze, register systems, confirm direction, move artifacts, validate), read `references/adoption-workflow.md`.

## Framework structure

Target projects converge to an 8-directory layout (`.framework/`, `references/`, `analyses/`, `systems/`, `iterations/`, `knowledge/`, `data/`, `releases/`). For the full structure diagram, intent-to-directory mapping, and `.framework/` managed files, read `references/framework-structure.md`.

## Systems and version control

Each system under `systems/` may be an independently version-controlled repository. The framework manages a **systems registry** (`.framework/systems-registry.json`) and per-system **contract files** (`systems/<name>/system.yaml`), not the system's source files.

- `vcs: independent-git` — the system path is its own git repository; the root repo `.gitignore` should ignore the system directory but allow `system.yaml`. Framework `check` skips internals.
- `vcs: embedded` — system files live in the root repo directly.
- Exactly one system has `status: primary` at any time. Use `system promote` to switch; the previous primary becomes `superseded` automatically.
- Archive non-primary systems with `system archive --apply` (copy-first move into `systems/archive/`).

Never hand-edit `.framework/systems-registry.json`. For the full registry schema, vcs semantics, gitignore patterns, and migration from layout v2, read `references/systems-registry.md`.

## Update policy

Always run `update --dry-run` before applying. User-modified files are skipped by default; use `--create-new` for sidecar copies or `--force` only with explicit user consent. For change classification rules, conflict flags, and backup behavior, read `references/update-policy.md`.

## Workflow

1. Inspect the target folder and any supplied external repository.
2. Run `init` if empty, `adopt --dry-run` then `--apply` if it has existing content, or `check`/`status` if it already has a MetaSystem manifest. If the workspace is layout v2, run `migrate-layout --dry-run` then `--apply` to create the systems registry.
3. Use `projects list` or `projects scan <parent-dir>` to locate existing workspaces.
4. Freeze external projects with `reference add` or manually under the `frozen/YYYYMM/` subdirectory of the workspace's references area.
5. Write an analysis card under `analyses/` with `analysis new`.
6. Convert promising findings into a candidate pattern under `analyses/patterns/`.
7. Start an iteration against `systems/<core>/` with `iteration start`.
8. Register active systems with `system register` (use `--primary` and `--vcs independent-git` when appropriate).
9. Close every started iteration with `iteration close --result ...` and every analysis with `analysis close --exit ...`. Promote durable findings into `knowledge/` with `knowledge add`.
10. Run `update --dry-run` before applying framework upgrades.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not adopt an already initialized MetaSystem workspace; use `update` or `migrate-layout` instead.
- Do not put external project source under `systems/`; freeze it under the workspace's `frozen/` references area.
- Do not hand-edit `.framework/manifest.json` or `.framework/systems-registry.json`; use the CLI.
- Do not set two systems as `primary` simultaneously; use `system promote`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress and `knowledge add` to promote.
- Do not leave iterations open indefinitely; `check` flags `Status: open` plans as warnings.
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

`check` reports four severity levels:

- `[ok]` — directory or managed file present and unchanged.
- `[warning]` — managed file modified by user, contract file missing, independent-git system without `.git`, or open iterations remain. Does not fail the check.
- `[missing]` — required directory or manifest absent.
- `[error]` — managed file missing from disk, registered system path missing, or two primary systems. **Exits non-zero.**

`status` shows `Systems` (with primary marker, vcs, version, supersedes chain), `Open iterations`, and `Knowledge entries`. For update and migrate, always run `--dry-run` first and review the plan before `--apply`.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.framework/VERSION` and layout version.
- Whether migration was only planned or applied.
- Which reference/analysis/iteration/knowledge artifacts were produced.
- Registered systems and the current `primary`.
- Any open iterations or unresolved warnings reported by `check`.
- Next recommended adoption, iteration, or close step.
