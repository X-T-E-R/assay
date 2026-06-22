---
name: metasystem-builder
description: "Build, adopt, update, analyze, and iterate MetaSystem framework workspaces. Use when the user wants to initialize a MetaSystem project, adopt an existing project into MetaSystem, learn from external projects, freeze references, create analyses, evolve local systems, register independently-version-controlled systems, promote or archive active systems, close iterations or analyses, manage ADRs, add knowledge entries, manage framework updates, or safely migrate old folders. Not for generic note-taking, arbitrary project scaffolding, or non-MetaSystem knowledge management workflows."
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
metasystem init [target-dir] --name <project-name> [--mode learning|absorption]
metasystem adopt --dry-run                        # always dry-run first
metasystem adopt --apply --name <project-name> [--analyze]  # --analyze opens an adoption inventory analysis
metasystem check                                  # semantic + structural + content-health validation
metasystem status                                 # systems + open iterations + knowledge counts
metasystem update --dry-run                       # always dry-run first
metasystem migrate-layout --dry-run               # always dry-run first; v2→v3 included

# Reference / analysis / iteration / knowledge
metasystem absorb <source-dir> [--name <name>]        # freeze + open a pre-filled analysis in ONE step
metasystem reference add <source-dir> <name>           # freeze only (writes reference.yaml, analyzed: false)
metasystem analysis new "Title" [--for-reference <path>]  # open an analysis; bind it to a frozen reference
metasystem analysis close <path> --exit adopt|reject|experiment|adr  # closes analysis; flips reference.yaml analyzed
metasystem iteration start "Title"
metasystem iteration close <selector> --result applied|rejected|retest [--note ...]
metasystem knowledge add <type> "Title" [--from-analysis <path>] [--from-iteration <path>]

# ADRs
metasystem adr new "Title" [--from-analysis <path>] [--from-iteration <path>]
metasystem adr accept <selector>
metasystem adr supersede <old-selector> <new-selector>
metasystem adr deprecate <selector>
metasystem adr list [--status proposed|accepted|superseded|deprecated] [--json]
metasystem adr show <selector> [--json]

# System registry (layout v3+)
metasystem system register <path> [--vcs independent-git|embedded|none] [--primary] [--supersedes <names>]
metasystem system promote <selector>
metasystem system archive <selector> --dry-run | --apply
metasystem system list [--status primary|active|superseded|archived] [--json]
metasystem system show <selector>

# Project registry
metasystem projects list | scan | show <selector> | forget <selector> | prune
```

For build instructions, PATH setup, and registry commands, read `references/cli-setup.md`. For lifecycle close semantics, read `references/lifecycle-commands.md`. For ADR state, frontmatter, and supersede-chain rules, read `references/adr-workflow.md`.

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

## Decisions and ADRs

Use ADRs for durable architecture decisions that need status, numbering, and supersede history. The framework stores ADR markdown under `knowledge/decisions/` and tracks the index in `.framework/adrs.json`.

- `adr new` creates a proposed ADR draft with required frontmatter.
- `adr accept` marks a proposed ADR as accepted.
- `adr supersede` records a bidirectional replacement chain between accepted ADRs.
- `adr deprecate` closes a proposed or accepted ADR without replacement.
- `check` validates dangling ADR links, non-bidirectional supersede chains, cycles, and missing ADR frontmatter.

Never hand-edit `.framework/adrs.json`. Use `adr` commands for lifecycle transitions. Read `references/adr-workflow.md` before creating or changing ADRs.

## Update policy

Always run `update --dry-run` before applying. User-modified files are skipped by default; use `--create-new` for sidecar copies or `--force` only with explicit user consent. For change classification rules, conflict flags, and backup behavior, read `references/update-policy.md`.

## Workflow

1. Inspect the target folder and any supplied external repository.
2. Run `init` if empty (use `--mode absorption` when the whole project exists to absorb a specific external thing — e.g. a contest, a paper, a repo you are rebuilding — so its official materials land in `problem/` instead of `references/frozen/`). Run `adopt --dry-run` then `--apply --analyze` if the directory already has existing content. Run `check`/`status` if it already has a MetaSystem manifest. If the workspace is layout v2, run `migrate-layout --dry-run` then `--apply`.
3. Use `projects list` or `projects scan <parent-dir>` to locate existing workspaces.

### Absorption pipeline (the core loop, made executable)

The loop `references → analyses → systems → iterations → knowledge` is NOT a directory-transfer graph where "file exists = step done". Each step must produce content before it counts as complete. Use this pipeline so work cannot be frozen and forgotten:

```
absorb <source>                      # freeze + write case file + OPEN a pre-filled analysis (one command)
  → fill ## Key observations / Adopt / Reject in the analysis   # content, not just a file
  → analysis close <path> --exit …   # flips reference.yaml analyzed:true, closes the loop
  → (adr | knowledge | iteration against systems/)              # the decision lands somewhere durable
```

4. **Absorb a source with `absorb <source> [--name <name>]`** — this freezes the source, writes a case file (`reference.yaml` in learning mode, `source.yaml` in absorption mode), AND opens a pre-filled analysis in one step. Prefer `absorb` over `reference add` followed by a separate `analysis new`, because `absorb` guarantees the analysis is opened in the same step and cannot be forgotten.
5. **Fill the analysis body**: complete `## Key observations`, `## Adopt`, `## Reject` with real content drawn from the source. `check` flags an analysis left at `Status: draft` with empty Key observations — an empty shell is incomplete work, not a finished step.
6. **Close the analysis** with `analysis close <path> --exit adopt|reject|experiment|adr`. This flips the bound reference's `analyzed` flag to `true` and writes the decision exit. For `--exit adr`, follow up with `adr new`; for reusable non-ADR knowledge, use `knowledge add`.
7. Convert promising findings into a candidate pattern under `analyses/patterns/`; start an iteration against `systems/<core>/` with `iteration start`.
8. Register active systems with `system register` (use `--primary` and `--vcs independent-git` when appropriate).
9. Close every started iteration with `iteration close --result ...`. `check` flags `Status: open` plans as warnings.
10. Run `update --dry-run` before applying framework upgrades.

### Adoption with direction

When adopting an existing project, `adopt --apply --analyze` opens an adoption inventory analysis listing every archived entry with a suggested destination. The default posture for absorption-mode and adoption work is: **propose a concrete move plan first (as a diff/preview or the inventory table), then apply on user confirmation** — not "stop and wait after archiving". Move archived entries into the new structure once the direction is clear; do not leave `.old/` as the final resting place. `check` warns on a lingering `.old/` until it is cleared.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not adopt an already initialized MetaSystem workspace; use `update` or `migrate-layout` instead.
- Do not put external project source under `systems/`; in learning mode freeze it under the workspace's `frozen/` references area; in absorption mode land it under `problem/` via `absorb`.
- Do not hand-edit `.framework/manifest.json`, `.framework/systems-registry.json`, or `.framework/adrs.json`; use the CLI.
- Do not set two systems as `primary` simultaneously; use `system promote`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress and `knowledge add` to promote.
- Do not leave iterations open indefinitely; `check` flags `Status: open` plans as warnings.
- Do not silently rename or delete legacy folders.
- Do not copy AGPL or incompatible upstream source into our skill; extract patterns and document decisions instead.
- Do not leave an external reference without an analysis exit: adopt, reject, experiment, or ADR.
- Do not freeze a source and then stop. A frozen reference with no analysis is incomplete work, not a completed step — `check` will warn on `unanalyzed reference`.

## Positive rules (what "absorbed" actually means)

- A frozen reference MUST be followed by an analysis with non-empty `Key observations` within the same session. Use `absorb` so this is automatic; if you used `reference add` alone, immediately run `analysis new --for-reference <path>` and fill it.
- An analysis is not "done" because the file exists. `## Key observations` must contain real observations drawn from the source; `## Adopt`/`## Reject` must state a decision. `check` enforces this.
- Closing an analysis (`analysis close --exit …`) is the action that marks a reference `analyzed: true`. Until then the reference is open work.
- In absorption mode, the source IS the project — do not treat official materials as external references. Land them in `problem/`.
- For adoption and absorption, propose the concrete destination first, then apply on confirmation. Do not stop after archiving.

## Validation

After any init, adopt, update, or migrate operation:

```bash
metasystem check
metasystem status
```

`check` reports four severity levels:

- `[ok]` — directory or managed file present and unchanged.
- `[warning]` — managed file modified by user, ADR frontmatter missing, contract file missing, independent-git system without `.git`, open iterations remain, **or a content-health issue**: unanalyzed frozen reference, empty draft analysis, stale `.old/` adoption archive, or pending queue entries. Does not fail the check.
- `[missing]` — required directory or manifest absent.
- `[error]` — managed file missing from disk, registered system path missing, two primary systems, or inconsistent ADR supersede links. **Exits non-zero.**

The content-health warnings are the framework's defense against "freeze then forget": a frozen reference with no analysis, an analysis left as an empty draft, a lingering `.old/`, or a pending queue are all surfaced so they cannot hide behind an `[ok]`.

`status` shows `Systems` (with primary marker, vcs, version, supersedes chain), `Open iterations`, and `Knowledge entries`. For update and migrate, always run `--dry-run` first and review the plan before `--apply`.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.framework/VERSION` and layout version.
- Whether migration was only planned or applied.
- Which reference/analysis/iteration/knowledge artifacts were produced.
- Which ADRs were created, accepted, superseded, deprecated, or left proposed.
- Registered systems and the current `primary`.
- **Content-completeness**: count of frozen references analyzed vs unanalyzed; count of open draft analyses and whether their `Key observations` are non-empty; whether `.old/` still contains un-migrated stamps. This is what distinguishes "files were created" from "content was actually absorbed".
- Any open iterations or unresolved warnings reported by `check`.
- Next recommended absorption, analysis close, iteration, or close step.
