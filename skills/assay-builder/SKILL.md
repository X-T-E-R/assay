---
name: assay-builder
description: "Build, adopt, update, analyze, and iterate Assay framework workspaces. Use when the user wants to initialize an Assay project, adopt an existing project into Assay, learn from external projects, freeze references, create analyses, evolve local systems, register independently-version-controlled systems, promote or archive active systems, close iterations or analyses, manage ADRs, add knowledge entries, manage framework updates, or safely migrate old folders. Not for generic note-taking, arbitrary project scaffolding, or non-Assay knowledge management workflows."
---

# Assay Builder

Build and maintain an Assay external-system-learning framework — a versioned project layer that stores external systems, analyzes them, converts validated patterns into our own framework, and iterates that framework over time.

## Prerequisites

- Node.js >= 18, `pnpm`
- This skill lives inside the `assay` repo and runs the repo's CLI directly — there is no bundled copy. Install by cloning the repo and running the repo-root installer from the cloned repository; it builds the workspace and links this skill into the selected skills directory so it resolves back to the repo.
- Invoke via the skill-local launcher `scripts/assay.mjs`; it walks up to the repo and runs `packages/assay-cli/dist/cli.js`. `dist/` is a build artifact (not committed) — the repo-root installer builds it, or build manually with `pnpm install && pnpm build`.
- Read `references/cli-setup.md` for install, build, and invocation details. Use `references/cli-setup.zh.md` when Chinese setup instructions are needed.

## Core loop

```text
references -> analyses -> systems -> iterations -> knowledge
```

Each transition has a CLI command and writes an event to `.framework/events/YYYY-MM.jsonl`. Open work is closed explicitly: iterations and analyses must be closed with a result/exit, and durable findings flow into `knowledge/`.

## CLI quick reference

Prefer the repo's CLI for all workspace operations — it preserves user files, writes a manifest, and keeps updates auditable. Invoke it from any working directory with the skill-local launcher (resolve `scripts/assay.mjs` relative to the skill root):

```bash
node <skill-root>/scripts/assay.mjs <command>
```

```bash
# Workspace lifecycle
assay init [target-dir] --name <project-name> [--mode learning|absorption]
assay adopt --dry-run                        # always dry-run first
assay adopt --apply --name <project-name> [--analyze]  # --analyze opens an adoption inventory analysis
assay check                                  # semantic + structural + content-health validation
assay status                                 # systems + living source summary + open iterations + knowledge counts
assay update --dry-run                       # always dry-run first
assay migrate-layout --dry-run               # always dry-run first; v2→v3 included

# Living sources / reference analysis / iteration / knowledge
assay source add <repo-or-dir> [alias] [--branch <branch>] [--capture checkout|thin|metadata|archive]
assay source sync [alias] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--sync]
assay source status [alias]
assay source diff <alias> [--since <observation>]
assay source log <alias>
assay absorb <source-dir> [--name <name>]        # legacy freeze + open a pre-filled analysis in ONE step
assay reference add <source-dir> <name>           # legacy/full-capture freeze only (writes reference.yaml, analyzed: false)
assay analysis new "Title" [--for-source <alias>] [--observation <id>] [--for-reference <path>]
assay analysis close <path> --exit adopt|reject|experiment|adr [--allow-empty]
assay iteration start "Title"
assay iteration close <selector> --result applied|rejected|retest [--note ...]
assay knowledge add <type> "Title" [--from-analysis <path>] [--from-iteration <path>]

# ADRs
assay adr new "Title" [--from-analysis <path>] [--from-iteration <path>]
assay adr accept <selector>
assay adr supersede <old-selector> <new-selector>
assay adr deprecate <selector>
assay adr list [--status proposed|accepted|superseded|deprecated] [--json]
assay adr show <selector> [--json]

# System registry (layout v3+)
assay system register <path> [--vcs independent-git|embedded|none] [--primary] [--supersedes <names>]
assay system promote <selector>
assay system archive <selector> --dry-run | --apply
assay system list [--status primary|active|superseded|archived] [--json]
assay system show <selector>

# Project registry
assay projects list | scan | show <selector> | forget <selector> | prune
```

For build instructions, PATH setup, and registry commands, read `references/cli-setup.md`. For lifecycle close semantics, read `references/lifecycle-commands.md`. For ADR state, frontmatter, and supersede-chain rules, read `references/adr-workflow.md`.

## Adopt an existing project

Use `adopt` when the current directory already contains a non-Assay project. Always run `--dry-run` first, review the plan, then `--apply`. The CLI archives root contents under `.old/<timestamp>/`, preserves `.git/`, and creates the standard scaffold.

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
2. Run `init` if empty (use `--mode absorption` when the whole project exists to absorb a specific external thing — e.g. a contest, a paper, a repo you are rebuilding — so its official materials land in `problem/` instead of the frozen-reference area). Run `adopt --dry-run` then `--apply --analyze` if the directory already has existing content. Run `check`/`status` if it already has an Assay manifest. If the workspace is layout v2, run `migrate-layout --dry-run` then `--apply`.
3. Use `projects list` or `projects scan <parent-dir>` to locate existing workspaces.

### Absorption pipeline (the core loop, made executable)

The loop `references → analyses → systems → iterations → knowledge` is NOT a directory-transfer graph where "file exists = step done". Each step must produce content before it counts as complete. Use this pipeline so work cannot be frozen and forgotten:

```
absorb <source>                      # freeze + write case file + OPEN a pre-filled analysis (one command)
  → fill ## Key observations / Adopt / Reject in the analysis   # content, not just a file
  → analysis close <path> --exit …   # flips reference.yaml analyzed:true, closes the loop
  → (adr | knowledge | iteration against systems/)              # the decision lands somewhere durable
```

4. **Add a living external source with `source add <repo-or-dir> [alias]`** when the source may change over time. The preferred human entrance is `references/<alias>/` with `source.yaml`, current `checkout/`, selected `materials/`, `history.md`, and the internal `.assay/` observation ledger. For Git-backed sources, `checkout/` itself is the repository root (`checkout/.git`), not `checkout/<repo-name>/`.
5. **Sync living sources with `source sync [alias]`** when the external system changes. For Git-backed sources, sync refreshes the managed checkout before observing. Use change classes as workflow gates: `same` writes an event only, `patch`/`normal` need delta analysis, `major` needs revalidation/stale-risk review, and `replacement` should become a new lineage instead of pretending it is a refresh.
6. **Use `absorb <source> [--name <name>]`** when you intentionally want the old freeze-and-open-analysis flow. This freezes the source, writes a case file (`reference.yaml` in learning mode, `source.yaml` in absorption mode), AND opens a pre-filled analysis in one step. Prefer `absorb` over `reference add` followed by a separate `analysis new`, because `absorb` guarantees the analysis is opened in the same step and cannot be forgotten.
7. **Open a source-bound analysis** with `analysis new "Title" --for-source <alias> [--observation <id>]` for living source observations, or `analysis new "Title" --for-reference <path>` for frozen references. When `--observation` is omitted, the latest observation for that source is used.
8. **Fill the analysis body**: complete `## Key observations` plus the relevant decision section (`## Adopt`, `## Reject`, or `## Next iteration`) with real content drawn from the source. `check` flags draft analyses with empty Key observations, and `analysis close` rejects empty shells by default.
9. **Close the analysis** with `analysis close <path> --exit adopt|reject|experiment|adr`. This flips the bound frozen reference's `analyzed` flag to `true` or marks the bound source observation `analysis_status: closed`, then writes the decision exit. For `--exit adr`, follow up with `adr new`; for reusable non-ADR knowledge, use `knowledge add`.
10. Convert promising findings into a candidate pattern under `analyses/patterns/`; start an iteration against the primary system in `systems/` with `iteration start`.
11. Register active systems with `system register` (use `--primary` and `--vcs independent-git` when appropriate).
12. Close every started iteration with `iteration close --result ...`. `check` flags `Status: open` plans as warnings.
13. Run `update --dry-run` before applying framework upgrades.

### Adoption with direction

When adopting an existing project, `adopt --apply --analyze` opens an adoption inventory analysis listing every archived entry with a suggested destination. The default posture for absorption-mode and adoption work is: **propose a concrete move plan first (as a diff/preview or the inventory table), then apply on user confirmation** — not "stop and wait after archiving". Move archived entries into the new structure once the direction is clear; do not leave `.old/` as the final resting place. `check` warns on a lingering `.old/` until it is cleared.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not adopt an already initialized Assay workspace; use `update` or `migrate-layout` instead.
- Do not put external project source under `systems/`; in learning mode add it as a living source under `references/<alias>/` with `source add`, or use frozen references only for explicit full-capture/legacy evidence. In absorption mode land project-owned material under `problem/` via `absorb`.
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
- A living source MUST keep provenance and observation metadata. Use `source status`, `source log`, `source diff`, and `analysis new --for-source` instead of browsing `.assay/` manually; `major` source changes require revalidation before old conclusions are treated as fresh.
- An analysis is not "done" because the file exists. `## Key observations` must contain real observations drawn from the source; `## Adopt`/`## Reject` must state a decision. `check` enforces this.
- Closing an analysis (`analysis close --exit …`) is the action that marks a frozen reference `analyzed: true` or a living source observation `analysis_status: closed`. Until then the source/referenced material is open work.
- In absorption mode, the source IS the project — do not treat official materials as external references. Land them in `problem/`.
- For adoption and absorption, propose the concrete destination first, then apply on confirmation. Do not stop after archiving.

## Validation

After any init, adopt, update, or migrate operation:

```bash
assay check
assay status
```

`check` reports four severity levels:

- `[ok]` — directory or managed file present and unchanged.
- `[warning]` — managed file modified by user, ADR frontmatter missing, contract file missing, independent-git system without `.git`, open iterations remain, **or a content-health issue**: unanalyzed frozen reference, major source observation needing revalidation, empty draft analysis, stale `.old/` adoption archive, or pending queue entries. Does not fail the check.
- `[missing]` — required directory or manifest absent.
- `[error]` — managed file missing from disk, registered system path missing, two primary systems, or inconsistent ADR supersede links. **Exits non-zero.**

The content-health warnings are the framework's defense against "freeze then forget": a frozen reference with no analysis, an analysis left as an empty draft, a lingering `.old/`, or a pending queue are all surfaced so they cannot hide behind an `[ok]`.

`status` shows `Systems` (with primary marker, vcs, version, supersedes chain), a compact `Living sources` summary, `Open iterations`, and `Knowledge entries`. For update and migrate, always run `--dry-run` first and review the plan before `--apply`.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.framework/VERSION` and layout version.
- Whether migration was only planned or applied.
- Which reference/analysis/iteration/knowledge artifacts were produced.
- Which ADRs were created, accepted, superseded, deprecated, or left proposed.
- Registered systems and the current `primary`.
- **Content-completeness**: count of living sources and whether latest observations have provenance/fingerprints/manifests; count of frozen references analyzed vs unanalyzed; count of open draft analyses and whether their `Key observations` are non-empty; whether `.old/` still contains un-migrated stamps. This is what distinguishes "files were created" from "content was actually absorbed".
- Any open iterations or unresolved warnings reported by `check`.
- Next recommended absorption, analysis close, iteration, or close step.
