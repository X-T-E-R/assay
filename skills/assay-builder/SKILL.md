---
name: assay-builder
description: "Build, adopt, update, analyze, and iterate Assay workspaces. Use when the user wants to initialize an Assay project, adopt an existing project into Assay, learn from external projects, freeze references, create analyses, evolve local systems, register independently-version-controlled systems, promote or archive active systems, close iterations or analyses, manage ADRs, add knowledge entries, manage framework updates, or safely migrate old folders. Not for generic note-taking, arbitrary project scaffolding, or non-Assay knowledge management workflows."
---

# Assay Builder

Build and maintain an Assay evidence workbench — a versioned project layer that stores sources, analyzes them, converts validated patterns into our own systems, and iterates over time.

## Prerequisites

- Node.js >= 18, `pnpm`
- This skill lives inside the `assay` repo and runs the repo's CLI directly — there is no bundled copy. Install by cloning the repo and running the repo-root installer from the cloned repository; it builds the workspace and links this skill into the selected skills directory so it resolves back to the repo.
- Invoke via the skill-local launcher `scripts/assay.mjs`; it walks up to the repo and runs the built TypeScript CLI at `packages/assay-cli/dist/cli.js`. `dist/` is a build artifact (not committed) — the repo-root installer builds it, or build manually with `pnpm install && pnpm build`.
- When maintaining this repository itself, use the release scripts (`scripts/check.sh` on POSIX, `scripts/check.ps1` on Windows). They run the built CLI checks and the committed public-example gate.
- Read `references/cli-setup.md` for install, build, and invocation details. Use `references/cli-setup.zh.md` when Chinese setup instructions are needed.

## Evidence loop

```text
evidence in -> structured checks -> decisions -> knowledge growth
```

Archetypes instantiate that loop with different workspace structures. `study` uses references and analyses for external systems; `solve` uses objectives, inputs, attempts, and benchmarks; `science`, `evaluation`, `explore`, and `library` keep their own evidence and decision shapes. Open work can be closed explicitly where the CLI provides lifecycle commands, and durable findings can flow into `knowledge/`; Assay records those choices without mechanically judging the prose.

## CLI quick reference

Prefer the repo's CLI for all workspace operations — it preserves user files, writes a manifest, and keeps updates auditable. Invoke it from any working directory with the skill-local launcher (resolve `scripts/assay.mjs` relative to the skill root):

```bash
node <skill-root>/scripts/assay.mjs <command>
```

```bash
# Workspace lifecycle
assay init [target-dir] --name <project-name> [--archetype <name>]  # built-ins: study|solve|science|evaluation|explore|library
assay adopt --dry-run                        # always dry-run first
assay adopt --apply --name <project-name> [--analyze]  # --analyze opens an adoption inventory analysis
assay check                                  # structure + persisted-record integrity
assay check --advisories                     # opt-in workflow/content reminders
assay status                                 # systems + living source summary + open iterations + knowledge counts
assay update --dry-run                       # always dry-run first
assay migrate-layout --dry-run               # always dry-run first; legacy layouts are migration input only

# Capability modules (optional features the archetype may not have enabled)
assay capability list [--json]               # which modules are enabled, and whether by archetype or added later
assay capability add <module>                # built-ins: adr|iteration; idempotent, safe to re-run

# Living sources / reference analysis / iteration / knowledge
assay source add <repo-or-dir> [alias] [--branch <branch>] [--capture checkout|archive]
assay source sync [alias] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--sync]
assay source status [alias]
assay source diff <alias> [--since <observation>]
assay source log <alias>

# Donor relationships / evidence / decisions
assay donor register --file <definition.json|yaml>
assay donor update <adoption> --file <definition.json|yaml>
assay donor list
assay donor show <adoption>
assay donor status [adoption] [--target <id>]
assay donor inspect <adoption> --target <id> [--to <observation>]
assay donor evidence add <adoption> <inspection> --file <evidence.json|yaml>
assay donor verify <adoption> <inspection>
assay donor decide <adoption> --target <id> --outcome accept|reject|defer [--inspection <id>] [--to <observation>] [--reason <text>]
assay donor history <adoption> [--target <id>]
assay donor rollback record <adoption> --to-decision <id> [--reason <text>]

assay absorb <source-dir> [--name <name>]        # legacy freeze + open a pre-filled analysis in ONE step
assay reference add <source-dir> <name>           # legacy/full-capture freeze only (writes reference.yaml, analyzed: false)
assay analysis new "Title" [--for-source <alias>] [--observation <id>] [--for-reference <path>]
assay analysis close <path> --exit adopt|reject|experiment|adr
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

# System registry
assay system register <path> [--vcs independent-git|embedded|none] [--primary] [--supersedes <names>]
assay system update <selector> [--path <path>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--contract-file <path> | --no-contract-file] [--primary] [--supersedes <names>]
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

Target projects use an archetype-specific layout over a shared base (`.assay/`, `systems/`, `knowledge/`). Built-ins then add directories such as `references/` + `analyses/` (`study`), `problem/` + `intake/` + `attempts/` (`solve`), `hypotheses/` + `experiments/` (`science`), `candidates/` + `scorecards/` (`evaluation`), or `approaches/` + `trials/` (`explore`). For the full structure guide and `.assay/` managed files, read `references/framework-structure.md`.

## Capability modules

`adr` and `iteration` are optional capability modules. An archetype enables some of them at init — `study` and `evaluation` ship `adr`, `solve`/`science`/`explore` ship `iteration`, `library` ships neither — and the rest can be enabled at any time.

- When a command reports `capability not enabled`, run `assay capability add <module>` instead of re-initializing the workspace or switching archetypes.
- `capability add` scaffolds the module's directories, templates, and state files through the workspace layout, records it in the manifest, and writes a `capability.added` event. Existing files are never overwritten, and re-running on an enabled module is a no-op.
- `capability list` distinguishes modules provided by the archetype from modules added afterwards. Use it before assuming an ADR or iteration command is unavailable.
- Capability-scaffolded files are managed files: `update` reconciles them and `check` treats their directories as required structure.

## Systems and version control

Each system under `systems/` may be an independently version-controlled repository. The framework manages a **systems registry** (`.assay/systems-registry.json`) and per-system **contract files** (`systems/<name>/system.yaml`), not the system's source files.

- `vcs: independent-git` — the system path is its own git repository; the root repo `.gitignore` should ignore the system directory but allow `system.yaml`. Framework `check` skips internals.
- `vcs: embedded` — system files live in the root repo directly.
- Exactly one system has `status: primary` at any time. Use `system promote` to switch; the previous primary becomes `superseded` automatically.
- Use `system update <selector>` to correct metadata for an existing record, for example `assay system update skill-creator --vcs independent-git --vcs-ref main` after a system was registered as `embedded` by mistake. Do not re-run `system register`; duplicate registration is intentionally rejected.
- Archive non-primary systems with `system archive --apply` (copy-first move into `systems/archive/`).

Never hand-edit `.assay/systems-registry.json`. For the full registry schema, vcs semantics, gitignore patterns, and migration notes for legacy layouts, read `references/systems-registry.md`.

## Decisions and ADRs

Use ADRs for durable architecture decisions that need status, numbering, and supersede history. The framework stores ADR markdown under `knowledge/decisions/` and tracks the index in `.assay/adrs.json`.

- `adr new` creates a proposed ADR draft with required frontmatter.
- `adr accept` marks a proposed ADR as accepted.
- `adr supersede` records a bidirectional replacement chain between accepted ADRs.
- `adr deprecate` closes a proposed or accepted ADR without replacement.
- `check` validates dangling ADR links, non-bidirectional supersede chains, cycles, and missing ADR frontmatter.
- External governance markers such as `.trellis/` and `.superpowers/` produce an advisory but never block an explicitly requested Assay ADR.

Never hand-edit `.assay/adrs.json`. Use `adr` commands for lifecycle transitions. Read `references/adr-workflow.md` before creating or changing ADRs.

## Update policy

Always run `update --dry-run` before applying. User-modified files are skipped by default; use `--create-new` for sidecar copies or `--force` only with explicit user consent. For change classification rules, conflict flags, and backup behavior, read `references/update-policy.md`.

## Workflow

1. Inspect the target folder and any supplied external repository.
2. Run `init` if empty (use `--archetype solve` when the whole project exists to work toward a specific measurable objective — e.g. a benchmark target, a paper implementation, or a repo you are rebuilding — so official materials land in `problem/` instead of the frozen-reference area). Run `adopt --dry-run` then `--apply --analyze` if the directory already has existing content. Run `check`/`status` if it already has an Assay manifest. If the workspace uses a legacy layout, run `migrate-layout --dry-run` then `--apply`.
3. Use `projects list` or `projects scan <parent-dir>` to locate existing workspaces.

### Study/absorption pipeline (the loop made executable)

The study-style pipeline `references → analyses → systems → iterations → knowledge` is NOT a directory-transfer graph where "file exists = step done". Each step must produce content before it counts as complete. Use this pipeline so work cannot be frozen and forgotten:

```
absorb <source>                      # freeze + write case file + OPEN a pre-filled analysis (one command)
  → fill ## Key observations / Adopt / Reject in the analysis   # content, not just a file
  → analysis close <path> --exit …   # flips reference.yaml analyzed:true, closes the loop
  → (adr | knowledge | iteration against systems/)              # the decision lands somewhere durable
```

4. **Add a living external source with `source add <repo-or-dir> [alias]`** when the source may change over time. The preferred human entrance is `references/<alias>/` with `source.yaml`, current `checkout/`, selected `materials/`, `history.md`, and the flat observation ledger (`observations/`, `manifests/`, `comparisons/`, `captures/`). For Git-backed sources, `checkout/` itself is the repository root (`checkout/.git`), not `checkout/<repo-name>/`.
5. **Sync living sources with `source sync [alias]`** when the external system changes. For Git-backed sources, sync refreshes the managed checkout before observing, and refuses to run when that checkout holds unrecorded work (modified or untracked files, an unrecorded local commit, or directory bytes differing from the latest observation) — preserve or discard the work in `references/<alias>/checkout/` first. Change classes record workflow meaning rather than imposing a universal gate: `same` writes an event only, `patch`/`normal` suggest delta analysis, `major` can be surfaced as a revalidation advisory, and `replacement` should usually become a new lineage instead of pretending it is a refresh.
6. **Register a donor relationship** when selected source material is carried into a registered system and should remain traceable across later updates. `donor inspect` reports direct source/target changes but is not mandatory before `donor decide`; evidence is advisory unless the definition explicitly marks it `required`. Assay records the relationship and decision while target edits, tests, commits, and restoration remain target-side actions. The definition schema, baseline model, and integrity boundary are documented in the repo's `docs/donor-adoption.md`.
7. **Use `absorb <source> [--name <name>]`** when you intentionally want the old freeze-and-open-analysis flow. This freezes the source, writes a case file (`reference.yaml` in learning mode, `source.yaml` in absorption mode), AND opens a pre-filled analysis in one step. Prefer `absorb` over `reference add` followed by a separate `analysis new`, because `absorb` guarantees the analysis is opened in the same step and cannot be forgotten.
8. **Open a source-bound analysis** with `analysis new "Title" --for-source <alias> [--observation <id>]` for living source observations, or `analysis new "Title" --for-reference <path>` for frozen references. When `--observation` is omitted, the latest observation for that source is used.
9. **Fill the analysis body when the decision needs durable rationale**: complete `## Key observations` plus the relevant decision section (`## Adopt`, `## Reject`, or `## Next iteration`) with real content drawn from the source. `check --advisories` can list empty drafts; `analysis close` trusts the caller's explicit exit and does not block on section-content heuristics.
10. **Close the analysis** with `analysis close <path> --exit adopt|reject|experiment|adr`. This flips the bound frozen reference's `analyzed` flag to `true` or marks the bound source observation `analysis_status: closed`, then writes the decision exit. For `--exit adr`, follow up with `adr new`; for reusable non-ADR knowledge, use `knowledge add`.
11. Convert promising findings into a candidate pattern under `analyses/patterns/`; start an iteration against the primary system in `systems/` with `iteration start`.
12. Register active systems with `system register` (use `--primary` and `--vcs independent-git` when appropriate). If a registered system's metadata is wrong, use `system update` to correct `vcs`, `vcs_ref`, version, path, contract file, supersedes, or primary status.
13. Close started iterations with `iteration close --result ...` when a result is known. `check --advisories` can list plans that still have `Status: open`.
14. Run `update --dry-run` before applying framework upgrades.

### Adoption with direction

When adopting an existing project, `adopt --apply --analyze` opens an adoption inventory analysis listing every archived entry with a suggested destination. The default posture for absorption-mode and adoption work is: **propose a concrete move plan first (as a diff/preview or the inventory table), then apply on user confirmation** — not "stop and wait after archiving". Move archived entries into the new structure once the direction is clear; `check --advisories` can report a lingering `.old/` when that reminder is useful.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not adopt an already initialized Assay workspace; use `update` or `migrate-layout` instead.
- Do not put external project source under `systems/`; in learning mode add it as a living source under `references/<alias>/` with `source add`, or use frozen references only for explicit full-capture/legacy evidence. In absorption mode land project-owned material under `problem/` via `absorb`.
- Do not hand-edit `.assay/manifest.json`, `.assay/systems-registry.json`, or `.assay/adrs.json`; use the CLI.
- Do not set two systems as `primary` simultaneously; use `system promote`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress and `knowledge add` to promote.
- Do not leave iterations open indefinitely; use `check --advisories` when you want a list of open plans.
- Do not silently rename or delete legacy folders.
- Do not copy AGPL or incompatible upstream source into our skill; extract patterns and document decisions instead.
- Do not leave an external reference without an analysis exit: adopt, reject, experiment, or ADR.
- Do not treat a frozen source as analyzed merely because it was copied. `check --advisories` can list frozen references without a cited analysis.

## Positive rules (what "absorbed" actually means)

- When a frozen reference is meant to inform a decision, follow it with an analysis containing the observations needed by that decision. `absorb` opens a bound draft automatically; `reference add` deliberately does not.
- A living source MUST keep provenance and observation metadata. Use `source status`, `source log`, `source diff`, and `analysis new --for-source` instead of browsing `.assay/` manually; `major` source changes require revalidation before old conclusions are treated as fresh.
- A file existing does not prove analysis quality. Use `## Key observations` and `## Adopt`/`## Reject` when durable rationale matters; Assay records explicit close decisions instead of pretending a mechanical text check can establish quality.
- Closing an analysis (`analysis close --exit …`) is the action that marks a frozen reference `analyzed: true` or a living source observation `analysis_status: closed`. Until then the source/referenced material is open work.
- In absorption mode, the source IS the project — do not treat official materials as external references. Land them in `problem/`.
- For adoption and absorption, propose the concrete destination first, then apply on confirmation. Do not stop after archiving.

## Validation

After any init, adopt, update, or migrate operation:

```bash
assay check
assay status
```

Run `assay check --advisories` separately when workflow reminders are useful.
`check` reports four severity levels:

- `[ok]` — directory or managed file present and unchanged.
- `[warning]` — managed file modified by user, ADR frontmatter missing, contract file missing, or independent-git system without `.git`. With `--advisories`, also includes open iterations, unanalyzed frozen references, major source observations that may need revalidation, empty draft analyses, stale `.old/` adoption archives, and pending queue entries. Warnings never fail the check.
- `[missing]` — required directory or manifest absent.
- `[error]` — managed file missing from disk, registered system path missing, source observation records missing required fingerprint/manifest state, two primary systems, inconsistent ADR supersede links, or invalid donor persistence. **Exits non-zero.**

Workflow/content reminders are opt-in because they describe work state, not corruption. Structure, registry/index consistency, managed-record integrity, and donor persistence remain in the default check.

`status` shows `Systems` (with primary marker, vcs, version, supersedes chain), a compact `Living sources` summary, a compact `Donor adoptions` summary when donor records exist, `Open iterations`, and `Knowledge entries`. For update and migrate, always run `--dry-run` first and review the plan before `--apply`. Dry-run commands must not create project files or project-registry records.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.assay/VERSION` and layout version.
- Whether migration was only planned or applied.
- Which reference/analysis/iteration/knowledge artifacts were produced.
- Which ADRs were created, accepted, superseded, deprecated, or left proposed.
- Registered systems and the current `primary`.
- **Content-completeness**: count of living sources and whether latest observations have provenance/fingerprints/manifests; count of frozen references analyzed vs unanalyzed; count of open draft analyses and whether their `Key observations` are non-empty; whether `.old/` still contains un-migrated stamps. This is what distinguishes "files were created" from "content was actually absorbed".
- Any open iterations or unresolved reminders reported by `check --advisories`, when that audit was requested.
- Next recommended absorption, analysis close, iteration, or close step.
