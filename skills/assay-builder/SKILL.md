---
name: assay-builder
description: "Use when building, adopting, updating, or analyzing a current Assay workspace through native Project, Task, Roadmap, Spec, Source, Analysis, Knowledge, System, Plugin, or Trellis workflows."
---

# Assay Builder

Build and maintain an Assay evidence workbench — a versioned project layer that stores sources, analyzes them, converts validated patterns into our own systems, and iterates over time.

## Prerequisites

- Node.js >= 18, `pnpm`
- This skill lives inside the `assay` repo and runs the repo's CLI directly — there is no bundled copy. Install by cloning the repo and running the repo-root installer from the cloned repository; it builds the workspace and links this skill into the selected skills directory so it resolves back to the repo.
- Invoke via the skill-local launcher `scripts/assay.mjs`; it walks up to the repo and runs the built TypeScript CLI at `packages/assay-cli/dist/cli.js`. `dist/` is a build artifact (not committed) — the repo-root installer builds it, or build manually with `pnpm install && pnpm build`.
- When maintaining this repository itself, use the repo-root release scripts (`../../scripts/check.sh` on POSIX, `../../scripts/check.ps1` on Windows). They run the built CLI checks and the committed public-example gate.
- Read `references/cli-setup.md` for install, build, and invocation details. Use `references/cli-setup.zh.md` when Chinese setup instructions are needed.

## Evidence loop

```text
evidence in -> structured checks -> decisions -> knowledge growth
```

Archetypes instantiate that loop with different workspace structures. `study` uses Sources and analyses for external systems; `solve` uses objectives, inputs, attempts, and benchmarks; `explore` uses parallel approaches and trials. A workspace that needs a different shape declares its own archetype YAML. Open work can be closed explicitly where the CLI provides lifecycle commands, and durable findings can flow into `knowledge/`; Assay records those choices without mechanically judging the prose.

## CLI quick reference

Prefer the repo's CLI for all workspace operations — it preserves user files, writes a manifest, and keeps updates auditable. Invoke it from any working directory with the skill-local launcher (resolve `scripts/assay.mjs` relative to the skill root):

```bash
node <skill-root>/scripts/assay.mjs <command>
```

```bash
# Workspace lifecycle
assay init [target-dir] --name <project-name> [--archetype <name>]  # built-ins: study|solve|explore
assay adopt --dry-run                        # always dry-run first
assay adopt --apply --name <project-name> [--analyze]  # --analyze opens an adoption inventory analysis
assay check                                  # structure + persisted-record integrity
assay check --advisories                     # opt-in workflow/content reminders
assay status [--json] [--fetch]              # archetype zones with purposes + systems + sources + upstream drift + counts
assay update --dry-run                       # always dry-run first

# Native Task (available without a plugin or capability)
assay task create --title <text> [--description <text>] [--name <display-slug>] [--creator <name>] [--assignee <name>] [--priority <priority>] [--relation <type:id...>] [--context <key>] [--json]
assay task show <id> [--json]
assay task list [--status active|paused|done|cancelled|superseded] [--archived live|archived|all] [--limit <n>] [--cursor <cursor>] [--json]
assay task status <id> <active|paused|done|cancelled|superseded> [--expected-revision <n>] [--json]
assay task checkpoint <id> --from <handoff.md> [--expected-revision <n>] [--json]
assay task finish <id> [--expected-revision <n>] [--json]
assay task archive <id> [--json]
assay task bind <id> --context <key> [--rebind] [--json]
assay task clear --context <key> [--json]
assay task current [--id <id>] [--context <key>] [--json]
assay task context [id] [--context <key>] [--json]
assay task relations <id> (--relation <type:id...> | --clear) [--expected-revision <n>] [--json]
assay task validate [id] [--json]

# Every Task leaf also accepts --root <dir> and --json.

# Workspace plugins (installed explicitly after workspace creation)
assay plugin add assay.trellis
assay trellis task create --title <title> --json
assay trellis task current --json
assay trellis protocol --json
assay trellis task complete|cancel|list|show|archive ... --json
assay trellis session|journal|config|channel|worker|mem ... --help
assay trellis migrate legacy plan|apply|rollback|cleanup ... --json
assay trellis context --host codex --json
assay trellis hook install --host codex [--dry-run | --apply] --json
assay trellis hook legacy plan|apply|restore --host codex --json
assay plugin disable assay.trellis                 # preserves runtime data
assay plugin uninstall assay.trellis --purge --yes # backup, then purge
assay plugin list [--json]
assay plugin check [--json]
assay reconcile [--plugin <id>...] [--dry-run | --apply] [--json]  # dry-run by default

# Sources / analysis / knowledge
assay source add <repo-or-dir> [alias] [--mode living|frozen] [--branch <branch>] [--capture checkout|archive]
assay source sync [alias] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--sync]
assay source status [alias]
assay source diff <alias> [--since <observation>]
assay source log <alias>

# Source adoption relationships / evidence / decisions
assay source adoption take <alias>:<source-path> --into <system>:<target-path> [--mode adapt|copy] [--to <observation>] [--id <adoption-id>]
assay source adoption register --file <definition.json|yaml>
assay source adoption update <adoption> --file <definition.json|yaml>
assay source adoption list
assay source adoption show <adoption>
assay source adoption status [adoption] [--target <id>]
assay source adoption inspect <adoption> --target <id> [--to <observation>]
assay source adoption evidence add <adoption> <inspection> --file <evidence.json|yaml>
assay source adoption verify <adoption> <inspection>
assay source adoption decide <adoption> --target <id> --outcome accept|reject|defer [--inspection <id>] [--to <observation>] [--reason <text>]
assay source adoption history <adoption> [--target <id>]
assay source adoption rollback record <adoption> --to-decision <id> [--reason <text>]

assay analysis new "Title" [--for-source <alias>] [--observation <id>]
assay analysis close <path> --exit adopt|reject|experiment [--note ...]
assay knowledge add <type> "Title" [--from-analysis <path>]


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


## Adopt an existing project

Use `adopt` when the current directory already contains a non-Assay project. Always run `--dry-run` first, review the plan, then `--apply`. The CLI archives root contents under `.old/<timestamp>/`, preserves `.git/`, and creates the standard scaffold.

For the full post-adoption workflow (inspect, analyze, register systems, confirm direction, move artifacts, validate), read `references/adoption-workflow.md`.

## Framework structure

Target projects use an archetype-specific layout over a shared base (`.assay/`, `project/`, `tasks/`, `systems/`, `knowledge/`; overlay resolves work folders under `.assay/`). Source and Analysis are native for every archetype but lazy outside `study`: their directories appear on the first Source or Analysis command. Built-ins add eager directories such as `sources/` + `analyses/` (`study`), `problem/` + `intake/` + `attempts/` (`solve`), or `approaches/` + `trials/` (`explore`). For the full structure guide and `.assay/` managed files, read `references/framework-structure.md`.

## Native Task

Use `assay task` when one bounded outcome needs a durable identity across
sessions, agents, context compaction, or implementation attempts. Create the
Task at that boundary, not for every piece of work. If the intended outcome is
unchanged, keep using the same Task when an attempt restarts or ownership moves.

Standalone Tasks live under `tasks/<stable-id>/`; overlay Tasks live under
`.assay/tasks/<stable-id>/`. Every Task requires `task.json` and `prd.md`.
`task.json` is a machine envelope and compatibility record; never put the Task
contract into it. People and models edit the bounded goal, scope, task-level
success checks, and references to governing acceptance directly in `prd.md`;
The native Project still owns project acceptance. Optional `design.md` and
`research/` hold Task-local material.

Write `handoff.md` only at a real continuation boundary. `checkpoint --from`
reads that Markdown and replaces the current checkpoint. Keep it to completed
outcomes, working state, verification evidence, the next action, and open
blockers or decisions. It is not a progress journal or a second PRD. The checkpoint must
contain these exact headings in order: `# Current State`,
`## Completed Outcomes`, `## Working State`, `## Verification Evidence`,
`## Next Action`, and `## Open Blockers and Decisions`.

Resume an existing Task in this order:

1. read the direct user request or host dispatch;
2. read the selected Task's `task.json` envelope;
3. read `prd.md` as the Task contract;
4. read a relevant `handoff.md` when one exists;
5. inspect the current repository, diff, and governing authority before acting.

Current selection is explicit stable id, then an exact host-context binding,
then none. Bindings live in `.assay/task-contexts.json`. Never infer current
from active count, newest record, or title; multiple active Tasks and duplicate
titles are valid. If `create --context` reports a binding conflict, the Task was
still created; use its returned id with `bind --rebind` instead of creating a
duplicate.

Task statuses are `active`, `paused`, `done`, `cancelled`, and `superseded`.
Treat `blocked` and `partial` as handoff narrative, not terminal states.
`finish` marks a Task `done` but does not archive it, change Git, accept it for
the project, change a roadmap, or promote Relay state. `archive` is explicit and
moves a terminal Task under `tasks/archive/<id>/`. A terminal Task does not
reopen; if the outcome continues afterwards, create a related successor Task.

Relations are `contributes_to`, `continues`, and `supersedes`. They preserve
lineage only: no authority, binding, assignment, status, completion, or
acceptance propagates through them.

Roadmap membership is not a Task relation or back-reference. Native Roadmap
items own canonical `task_refs`; change them with `assay roadmap link-task` or
`unlink-task`. Task and Roadmap lifecycle state never propagates automatically.

`task list` uses partial-health output. It keeps valid rows in stdout/JSON while
placing corrupt or duplicate storage diagnostics in top-level `issues` (or a
human `Task storage issues:` section), and exits 1 when any issue exists. Use
the valid rows for discovery, but do not report the storage as healthy until
the issues are repaired.

Keep roadmaps, specifications, and acceptance in the native Project. Use
Use `assay spec` for closed envelopes plus reader-owned specification prose,
and use explicit `spec promote` only with an independent clean body and an
Analysis or Task provenance source. Activation validates structure; it is not
approval or Project acceptance. Keep agent DAGs, dispatch, ownership, and
permissions in the host. Relay owns fork and promotion semantics. Keep product
learning and durable findings in analyses and knowledge.

## Workspace plugins

- `assay plugin add assay.trellis` explicitly declares and installs the retained built-in workspace runtime. Fresh `init`, `attach`, `study`, `solve`, and `explore` workspaces do not install a plugin implicitly.
- `reconcile` only operates on a workspace that already has a current `.assay/manifest.json`. It is a write-free preview unless `--apply` is present, and a converged apply does not update timestamps or append an event.
- `plugin register` validates and locks an independently packaged external descriptor under `.assay/external-plugins.json`. It never imports, installs, activates, or executes the payload. A descriptor may list several hosts and omit unknown target versions, records SPDX/license-source metadata, and distinguishes safe Assay-relative state from opaque host locators. `plugin observe` requires a concrete host version and rejects identity, integrity, undeclared-host, declared exact-version, grant, surface, or ownership mismatches. Assay never resolves or deletes host locators. Missing evidence remains unobserved or unverifiable. Disable, enable, and remove change only Assay control-plane records and grant no native responsibility, Task, or workspace authority.
- External descriptor `requests.capabilities` remains opaque host-request metadata. Status exposes it as `requestedCapabilities`; it does not enable a native Assay feature or grant host permission.
- Trellis `runtimeCapabilities` describe only the retained Phase 6 workspace runtime. They are not project capability modules.

Assay 0.9 has no native product-Intent object or capability-module commands. A manually created `intent/` or `.assay/intent/` directory is generic unowned content: Assay does not parse, promote, rewrite, migrate, or delete it. Keep product requirements in native Specifications or reader-owned Project prose, and preserve verbatim external evidence in its authoritative source or an Analysis when appropriate.


## Systems and version control

Each system under `systems/` may be an independently version-controlled repository. The framework manages a **systems registry** (`.assay/systems-registry.json`) and per-system **contract files** (`systems/<name>/system.yaml`), not the system's source files.

- `vcs: independent-git` — the system path is its own git repository; the root repo `.gitignore` should ignore the system directory but allow `system.yaml`. Framework `check` skips internals.
- `vcs: embedded` — system files live in the root repo directly.
- Exactly one system has `status: primary` at any time. Use `system promote` to switch; the previous primary becomes `superseded` automatically.
- Use `system update <selector>` to correct metadata for an existing record, for example `assay system update skill-creator --vcs independent-git --vcs-ref main` after a system was registered as `embedded` by mistake. Do not re-run `system register`; duplicate registration is intentionally rejected.
- Archive non-primary systems with `system archive --apply` (copy-first move into `systems/archive/`).

Never hand-edit `.assay/systems-registry.json`. For the full registry schema, vcs semantics, gitignore patterns, and migration notes for legacy layouts, read `references/systems-registry.md`.





## Update policy

Always run `update --dry-run` before applying. User-modified files are skipped by default; use `--create-new` for sidecar copies or `--force` only with explicit user consent. For change classification rules, conflict flags, and backup behavior, read `references/update-policy.md`.

## Workflow

1. Inspect the target folder and any supplied external repository.
2. Use `projects list` or `projects scan <parent-dir>` to locate existing workspaces.

### Source evidence pipeline

The study-style flow `sources → analyses → systems + knowledge` is not a directory-transfer graph where "file exists = step done". Each step must produce content before it counts as complete:

```
source add <source> <alias> --mode frozen
  → analysis new "Review" --for-source <alias>
  → fill ## Key observations / Adopt / Reject in the analysis   # content, not just a file
  → analysis close <path> --exit …   # records the decision exit, closes the loop
```

3. **Add external evidence with `source add <repo-or-dir> [alias] --mode living|frozen`.** Living Sources default to checkout capture. Frozen Sources force archive capture, share the same `sources/<alias>/` namespace, and cannot sync or switch. The ledger uses `observations/`, `manifests/`, and `captures/`; diffs are derived rather than persisted, while `materials/` remains user-owned evidence.
4. **Read upstream drift out of `status`, not out of a maintenance command.** The `Upstream` section compares each managed checkout against the commit its latest observation recorded, with no network, and names the Source adoption mappings a change reaches. `status --fetch` adds a remote comparison; a source it cannot reach is annotated and the command still exits 0. Run `source sync` when that section reports new upstream commits — and never as a routine habit.
5. **Sync living Sources with `source sync [alias]`** when the external system changes. For Git-backed sources, sync refreshes the managed checkout before observing, and refuses to run when that checkout holds unrecorded work (modified or untracked files, an unrecorded local commit, or directory bytes differing from the latest observation) — preserve or discard the work in `sources/<alias>/checkout/` first. Change classes record workflow meaning rather than imposing a universal gate: `same` writes an event only, `patch`/`normal`/`major` describe the observed delta, and `replacement` should usually become a new lineage instead of pretending it is a refresh.
6. **Register a Source adoption** when selected source material is carried into a registered system and should remain traceable across later updates. `source adoption take` covers one mapping; `source adoption register --file` covers several mappings, targets, or required evidence. Evidence is advisory unless the definition marks it `required`.
7. **Open a source-bound analysis** with `analysis new "Title" --for-source <alias> [--observation <id>]`. Living and frozen Sources use the same resolver. Analysis close changes only the Analysis; Source observations remain immutable.
9. **Fill the analysis body when the decision needs durable rationale**: complete `## Key observations` plus the relevant decision section (`## Adopt`, `## Reject`, or `## Next step`) with real content drawn from the source. `check --advisories` can list empty drafts; `analysis close` trusts the caller's explicit exit and does not block on section-content heuristics.
10. Convert promising findings into a candidate pattern under `analyses/patterns/`. Create a native Task only when future bounded work needs a complete Goal, Acceptance Criteria, and durable identity.
11. Register active systems with `system register` (use `--primary` and `--vcs independent-git` when appropriate). If a registered system's metadata is wrong, use `system update` to correct `vcs`, `vcs_ref`, version, path, contract file, supersedes, or primary status.
12. Run `update --dry-run` before applying framework upgrades.

### Adoption with direction

When adopting an existing project, `adopt --apply --analyze` opens an adoption inventory analysis listing every archived entry with a suggested destination. The default posture for absorption-mode and adoption work is: **propose a concrete move plan first (as a diff/preview or the inventory table), then apply on user confirmation** — not "stop and wait after archiving". Move archived entries into the new structure once the direction is clear; `check --advisories` can report a lingering `.old/` when that reminder is useful.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not hand-edit native `task.json` or `.assay/task-contexts.json`; edit `prd.md` directly and use `assay task` for machine metadata, lifecycle, relationships, and bindings.
- Do not create a new Task for another attempt at the same bounded outcome, and do not write `handoff.md` after every update. Checkpoint only at a real continuation boundary.
- Do not treat Task creation, binding, relationships, or `finish` as permission, assignment, project acceptance, Git closeout, roadmap state, or Relay promotion.
- Do not put external evidence under `systems/`; add it as a living or frozen Source under `sources/<alias>/`.
- Do not set two systems as `primary` simultaneously; use `system promote`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress and `knowledge add` to promote.
- Do not silently rename or delete legacy folders.
- Do not copy AGPL or incompatible upstream source into our skill; extract patterns and document decisions instead.
- Do not treat a frozen Source as adopted merely because it was copied; a freeze without an Analysis exit is unfinished work.
- Do not run `source sync` as a routine sweep. Read the `Upstream` section of `status` and sync the sources it reports as moved.

## Positive rules (what "absorbed" actually means)

- When a frozen Source is meant to inform a decision, follow it with a source-bound Analysis containing the observations needed by that decision.
- A living Source MUST keep provenance and observation metadata. Use `source status`, `source log`, `source diff`, and `analysis new --for-source` instead of browsing `.assay/` manually. Source observations never store Analysis status; decide explicitly when a changed Source needs a new Analysis.
- A file existing does not prove analysis quality. Use `## Key observations` and `## Adopt`/`## Reject` when durable rationale matters; Assay records explicit close decisions instead of pretending a mechanical text check can establish quality.
- Closing an analysis (`analysis close --exit …`) records only the Analysis decision; it never rewrites Source observations.
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
- `[missing]` — required directory or manifest absent.

Workflow/content reminders are opt-in because they describe work state, not corruption. Structure, registry and persisted-record consistency, managed-record integrity, and Source adoption receipt remain in the default check.

`status` opens with the archetype and its one-line description, then `Zones`: the directories that archetype declares, each with a file count and what belongs in it. Read the zones before placing a file — they are the workspace's own statement of where work goes, and they differ per archetype. After that it shows `Systems` (with primary marker, vcs, version, supersedes chain), a compact `Sources` summary, an `Upstream` block naming each source that drifted and how many Source adoption mappings the change reaches (add `--fetch` to compare remotes as well), a compact `Source adoptions` summary when operational receipts exist, `Knowledge entries`, and `Run records (runs.jsonl)` where that file exists. Use `--json` for the same data machine-readably. Run `update --dry-run` before apply; dry-run commands must not create project files or project-registry records.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.assay/VERSION` and layout version.
- Whether migration was only planned or applied.
- Which Source, Analysis, Task, or Knowledge artifacts were produced.
- Registered systems and the current `primary`.
- **Content-completeness**: count of living Sources and whether latest observations have provenance/fingerprints/manifests; count of living and frozen Source modes; count of open draft analyses and whether their `Key observations` are non-empty; whether `.old/` still contains un-migrated stamps. This is what distinguishes "files were created" from "content was actually evaluated".
- Any unresolved reminders reported by `check --advisories`, when that audit was requested.
- Next recommended absorption, Analysis close, Task, or Knowledge step.
