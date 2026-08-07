---
name: assay-builder
description: "Build, adopt, update, analyze, and iterate Assay workspaces. Use when the user wants to initialize an Assay project, adopt an existing project into Assay, learn from external projects, freeze references, create analyses, evolve local systems, register independently-version-controlled systems, promote or archive active systems, close iterations or analyses, capture product intent verbatim and promote it into requirements or decisions, manage ADRs, add knowledge entries, manage framework updates, or safely migrate old folders. Not for generic note-taking, arbitrary project scaffolding, or non-Assay knowledge management workflows."
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

Archetypes instantiate that loop with different workspace structures. `study` uses references and analyses for external systems; `solve` uses objectives, inputs, attempts, and benchmarks; `explore` uses parallel approaches and trials. A workspace that needs a different shape declares its own archetype YAML. Open work can be closed explicitly where the CLI provides lifecycle commands, and durable findings can flow into `knowledge/`; Assay records those choices without mechanically judging the prose.

## CLI quick reference

Prefer the repo's CLI for all workspace operations — it preserves user files, writes a manifest, and keeps updates auditable. Invoke it from any working directory with the skill-local launcher (resolve `scripts/assay.mjs` relative to the skill root):

```bash
node <skill-root>/scripts/assay.mjs <command>
```

```bash
# Workspace lifecycle
assay init [target-dir] --name <project-name> [--archetype <name>] [--plugin assay.intent|assay.trellis]  # built-ins: study|solve|explore
assay adopt --dry-run                        # always dry-run first
assay adopt --apply --name <project-name> [--analyze]  # --analyze opens an adoption inventory analysis
assay check                                  # structure + persisted-record integrity
assay check --advisories                     # opt-in workflow/content reminders
assay status [--json] [--fetch]              # archetype zones with purposes + systems + sources + upstream drift + counts
assay update --dry-run                       # always dry-run first
assay migrate-layout --dry-run               # always dry-run first; legacy layouts are migration input only

# Capability modules (optional features the archetype may not have enabled)
assay capability list [--json]               # which modules are enabled, and whether by archetype or added later
assay capability add <module>                # built-ins: adr|intent|iteration|project-authority; idempotent, safe to re-run

# Workspace plugins (extend an existing Assay workspace)
assay plugin add assay.intent
assay plugin add assay.trellis
assay plugin register <descriptor.json> [--json]     # lock external metadata; execute nothing
assay plugin observe <observation.json> [--json]     # import a matching host report
assay plugin disable|enable <external-id> [--json]   # Assay-side contribution only
assay plugin remove <external-id> [--json]           # preserve package and host state
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

# Product intent (what was asked for, kept apart from what was built)
assay intent capture [--text <text> | --file <workspace-relative-path>] [--system <name>] [--source <text>] [--supersedes <ids>] [--force]
assay intent promote <capture-id> --to requirement|decision [--title <title>]
assay intent list [--system <name>] [--include-lineage] [--json]

# Living sources / reference analysis / iteration / knowledge
assay source add <repo-or-dir> [alias] [--branch <branch>] [--capture checkout|archive]
assay source sync [alias] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--sync]
assay source status [alias]
assay source diff <alias> [--since <observation>]
assay source log <alias>

# Donor relationships / evidence / decisions
assay donor take <alias>:<source-path> --into <system>:<target-path> [--mode adapt|copy] [--to <observation>] [--id <adoption-id>]
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
assay reference add <source-dir> <name>           # legacy/full-capture freeze only (writes reference.yaml provenance)
assay reference backfill <path> [--source <origin>]  # write the missing reference.yaml for an older frozen directory
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
assay adr list [--status proposed|accepted|superseded|deprecated] [--native] [--json]
assay adr show <selector> [--native] [--json]

# System registry
assay system register <path> [--vcs independent-git|embedded|none] [--primary] [--supersedes <names>] [--intent-authority inline|external|none] [--intent-pointer <pointer>]
assay system update <selector> [--path <path>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--contract-file <path> | --no-contract-file] [--primary] [--supersedes <names>] [--intent-authority inline|external|none | --no-intent-authority] [--intent-pointer <pointer>]
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

Target projects use an archetype-specific layout over a shared base (`.assay/`, `systems/`, `knowledge/`). Built-ins then add directories such as `references/` + `analyses/` (`study`), `problem/` + `intake/` + `attempts/` (`solve`), or `approaches/` + `trials/` (`explore`). For the full structure guide and `.assay/` managed files, read `references/framework-structure.md`.

## Capability modules

`adr`, `intent`, `iteration`, and `project-authority` are optional capability modules. An archetype enables some of them at init — `study` ships `adr`, `solve` and `explore` ship `iteration`, and no archetype ships `intent` or `project-authority` — and the rest can be enabled at any time. Intent's preferred entrance is now the built-in `assay.intent` plugin.

- When an intent command reports `capability not enabled`, run `assay plugin add assay.intent`. For ADR, iteration, or Project Authority, run `assay capability add <module>`.
- `capability add` scaffolds the module's directories, templates, and state files through the workspace layout, records it in the manifest, and writes a `capability.added` event. Existing files are never overwritten, and re-running on an enabled module is a no-op.
- `capability list` distinguishes modules provided by the archetype from modules added afterwards. Use it before assuming ADR, intent, iteration, or Project Authority is unavailable.
- Capability-scaffolded files are managed files: `update` reconciles them and `check` treats their directories as required structure.
- `assay capability add project-authority` creates `facts/`, `policy/`, `norms/`, `specs/`, and `relay/` under the workspace work root. The project owns its facts and constraints and owns and selects activation, fork, and promotion records; Relay interprets Relay documents and schemas. Assay only creates and protects the location: it creates no empty Relay activation, parses no Relay schema, and decides no fact, constraint, permission, or acceptance result. Standalone uses `project-authority/`; every overlay privacy mode uses `.assay/project-authority/` and never writes the product root implicitly.
- `plugin add assay.intent` declares desired plugin state, scaffolds only missing files, and records installation in `.assay/plugins.json`. `assay capability add intent` stays compatible for existing automation.
- `reconcile` only operates on a workspace that already has `.assay/manifest.json`. It is a write-free preview unless `--apply` is present. A complete legacy intent scaffold is adopted without rewriting it; an incomplete one gets only its missing files. A converged apply does not update timestamps or append an event.
- `plugin add assay.trellis` installs Assay's built-in operational v1 runtime under `.assay/trellis/`. It does not call a Trellis CLI or depend on `.trellis/`, and it does not replace Assay-native ADR or intent authority. Tasks, sessions, journal, config, channels/leases, and external-worker state are durable project-local domains; Codex memory is bounded and read-only. Optional session ids fail closed when an unscoped current task would be ambiguous. Built-in provider-process supervision is deferred: workers register and drive the CLI themselves.
- `plugin register` validates and locks an independently packaged external descriptor under `.assay/external-plugins.json`. It never imports, installs, activates, or executes the payload. A descriptor may list several hosts and omit unknown target versions, records SPDX/license-source metadata, and distinguishes safe Assay-relative state from opaque host locators. `plugin observe` requires a concrete host version and rejects identity, integrity, undeclared-host, declared exact-version, grant, surface, or ownership mismatches. Assay never resolves or deletes host locators. Missing evidence remains unobserved/unverifiable. Disable/enable/remove change only Assay control-plane records and grant no native capability, responsibility, or decision authority.

## Product intent

Intent is what was asked for, kept apart from what was built. Capture it when the wording itself is the evidence: a feature request, a scope correction, a constraint someone stated out loud. Do not paraphrase into a requirement first — that is what `promote` is for.

- `intent capture` writes `intent/original/<YYYYMMDD>-<sha256:12>.md` with the text verbatim plus the resolved system, the body's SHA-256, and the capture time. `--file` is workspace-relative and refuses to leave the workspace; use `--text` for material from elsewhere.
- Records are append-only. Re-capturing identical text is a no-op, and `--source` or `--supersedes` given to that repeat call are reported as ignored rather than applied. Re-capturing the same text against a different system, or with a different shadow marking, fails instead of resolving to the first record. `--supersedes` takes recorded capture ids and refuses anything else. Re-capturing text whose record was edited afterwards fails with both digests. Never edit a file under `intent/original/`; capture the corrected wording with `--supersedes <capture-id>`.
- `intent list` marks a record that no longer matches what was recorded (`[modified after recording]`, or `[unreadable record]` when it no longer parses) and keeps listing the rest, so one damaged file does not blind the whole workspace. Restore it from version control; do not rewrite it to make the marker go away.
- Every capture is scoped to one registered system, resolved at capture time. Register the system first. After `system promote` moves the primary pointer, old captures keep naming the system they were about; use `intent list --system <name> --include-lineage` to follow the registry `supersedes` chain across replacements.
- If the system records `intent_authority: external` or `none`, capture refuses and prints the pointer. That is an authority boundary, not a policy check — Assay does not verify the pointer is reachable. `--force` records a `shadow: true` copy for local convenience; `intent list` flags it. Prefer recording in the authoritative place.
- `promote --to requirement` writes `intent/requirements/<date>-<slug>.md` with `derives_from`. `promote --to decision` creates an ADR carrying `related_intent` and `system`, so the decision cites the words it answers. There is no `intent/decisions/`.
- **Assay stores captured text as given.** It does not scan or redact. Remove credentials and personal data before capturing, and ask the user before capturing a conversation they have not reviewed. See the repo's `docs/agent-instructions.md`.
- In a private overlay (`attach --privacy private`), `.assay/` has no version history. `check --advisories` recommends `private-git` when intent is enabled there; act on it before the workspace accumulates captures.

### Recovering intent when adopting an existing project

An adopted project usually has its intent scattered across issues, chat logs, and old docs rather than in the repo. Recover it in one pass instead of leaving it in `.old/`:

```bash
assay adopt --apply --name <project> --analyze   # existing content lands in .old/<timestamp>/
assay system register systems/<primary> --primary
assay plugin add assay.intent
# then, for each distinct statement of intent found in the archive:
assay intent capture --file .old/<timestamp>/docs/original-brief.md --source ".old/<timestamp>/docs/original-brief.md"
assay intent capture --text "<quoted request from an issue or chat>" --source "issue #142"
```

Capture the statements, not the whole archive: one record per distinct thing that was asked for, each with a `--source` that says where the wording came from. Then promote the ones that are still live into requirements or ADRs, and let `intent list` show what has been converted and what is still just a request. Backfilled captures carry the date they were recorded, not the date they were written; keep the original date in `--source`.

## Systems and version control

Each system under `systems/` may be an independently version-controlled repository. The framework manages a **systems registry** (`.assay/systems-registry.json`) and per-system **contract files** (`systems/<name>/system.yaml`), not the system's source files.

- `vcs: independent-git` — the system path is its own git repository; the root repo `.gitignore` should ignore the system directory but allow `system.yaml`. Framework `check` skips internals.
- `vcs: embedded` — system files live in the root repo directly.
- Exactly one system has `status: primary` at any time. Use `system promote` to switch; the previous primary becomes `superseded` automatically.
- Use `system update <selector>` to correct metadata for an existing record, for example `assay system update skill-creator --vcs independent-git --vcs-ref main` after a system was registered as `embedded` by mistake. Do not re-run `system register`; duplicate registration is intentionally rejected.
- `--intent-authority inline|external|none` (with `--intent-pointer` for `external`) declares where a system's product intent is authoritative. Absent means `inline`. Set `external` when another tool owns the intent record, so `intent capture` fail-closes here instead of creating a second source of truth. The registry is the authority every command reads; a `system.yaml` contract carries the field only when `register` generated it, so read `system show <name>` rather than the contract file.
- Archive non-primary systems with `system archive --apply` (copy-first move into `systems/archive/`).

Never hand-edit `.assay/systems-registry.json`. For the full registry schema, vcs semantics, gitignore patterns, and migration notes for legacy layouts, read `references/systems-registry.md`.

## Decisions and ADRs

Use ADRs for durable architecture decisions that need status, numbering, and supersede history. The framework stores ADR markdown under `knowledge/decisions/` and tracks the index in `.assay/adrs.json`.

- `adr new` creates a proposed ADR draft with required frontmatter.
- `adr accept` marks a proposed ADR as accepted.
- `adr supersede` records a bidirectional replacement chain between accepted ADRs.
- `adr deprecate` closes a proposed or accepted ADR without replacement.
- `check` validates dangling ADR links, non-bidirectional supersede chains, cycles, and missing ADR frontmatter.
- External governance markers such as `.trellis/` and `.superpowers/` may still produce the legacy advisory, but the built-in `assay.trellis` runtime is independent of those markers. Native ADR mutations, intent-to-decision promotion, and decision knowledge writes remain available.

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
  → analysis close <path> --exit …   # records the decision exit, closes the loop
  → (adr | knowledge | iteration against systems/)              # the decision lands somewhere durable
```

4. **Add a living external source with `source add <repo-or-dir> [alias]`** when the source may change over time. The preferred human entrance is `references/<alias>/` with `source.yaml`, current `checkout/`, selected `materials/`, `history.md`, and the flat observation ledger (`observations/`, `manifests/`, `comparisons/`, `captures/`). For Git-backed sources, `checkout/` itself is the repository root (`checkout/.git`), not `checkout/<repo-name>/`.
5. **Read upstream drift out of `status`, not out of a maintenance command.** The `Upstream` section compares each managed checkout against the commit its latest observation recorded, with no network, and names the donor mappings a change reaches. `status --fetch` adds a remote comparison; a source it cannot reach is annotated and the command still exits 0. Run `source sync` when that section reports new upstream commits — and never as a routine habit.
6. **Sync living sources with `source sync [alias]`** when the external system changes. For Git-backed sources, sync refreshes the managed checkout before observing, and refuses to run when that checkout holds unrecorded work (modified or untracked files, an unrecorded local commit, or directory bytes differing from the latest observation) — preserve or discard the work in `references/<alias>/checkout/` first. Change classes record workflow meaning rather than imposing a universal gate: `same` writes an event only, `patch`/`normal` suggest delta analysis, `major` can be surfaced as a revalidation advisory, and `replacement` should usually become a new lineage instead of pretending it is a refresh.
7. **Register a donor relationship** when selected source material is carried into a registered system and should remain traceable across later updates. For one source path into one system path, `donor take <alias>:<path> --into <system>:<path>` records it in a single command; `donor register --file` covers several mappings, several targets, or required evidence. Afterwards `status` answers "did the source change, and does it reach this adoption"; `donor inspect` remains the explicit verb for writing an immutable inspection record, and is not required before `donor decide`. Evidence is advisory unless the definition explicitly marks it `required`. Assay records the relationship and decision while target edits, tests, commits, and restoration remain target-side actions. The definition schema, baseline model, and integrity boundary are documented in the repo's `docs/donor-adoption.md`.
8. **Use `absorb <source> [--name <name>]`** when you intentionally want the old freeze-and-open-analysis flow. This freezes the source, writes a case file (`reference.yaml` in learning mode, `source.yaml` in absorption mode), AND opens a pre-filled analysis in one step. Prefer `absorb` over `reference add` followed by a separate `analysis new`, because `absorb` guarantees the analysis is opened in the same step and cannot be forgotten.
9. **Open a source-bound analysis** with `analysis new "Title" --for-source <alias> [--observation <id>]` for living source observations, or `analysis new "Title" --for-reference <path>` for frozen references. When `--observation` is omitted, the latest observation for that source is used.
10. **Fill the analysis body when the decision needs durable rationale**: complete `## Key observations` plus the relevant decision section (`## Adopt`, `## Reject`, or `## Next iteration`) with real content drawn from the source. `check --advisories` can list empty drafts; `analysis close` trusts the caller's explicit exit and does not block on section-content heuristics.
11. **Close the analysis** with `analysis close <path> --exit adopt|reject|experiment|adr`. This marks a bound source observation `analysis_status: closed` and writes the decision exit. For `--exit adr`, use Assay-native `adr new`; the built-in `assay.trellis` runtime never replaces decision authority. For reusable non-ADR knowledge, use `knowledge add`.
12. Convert promising findings into a candidate pattern under `analyses/patterns/`; start an iteration against the primary system in `systems/` with `iteration start`.
13. Register active systems with `system register` (use `--primary` and `--vcs independent-git` when appropriate). If a registered system's metadata is wrong, use `system update` to correct `vcs`, `vcs_ref`, version, path, contract file, supersedes, or primary status.
14. Close started iterations with `iteration close --result ...` when a result is known. `check --advisories` can list plans that still have `Status: open`.
15. Run `update --dry-run` before applying framework upgrades.

### Adoption with direction

When adopting an existing project, `adopt --apply --analyze` opens an adoption inventory analysis listing every archived entry with a suggested destination. The default posture for absorption-mode and adoption work is: **propose a concrete move plan first (as a diff/preview or the inventory table), then apply on user confirmation** — not "stop and wait after archiving". Move archived entries into the new structure once the direction is clear; `check --advisories` can report a lingering `.old/` when that reminder is useful.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not adopt an already initialized Assay workspace; use `update` or `migrate-layout` instead.
- Do not put external project source under `systems/`; in learning mode add it as a living source under `references/<alias>/` with `source add`, or use frozen references only for explicit full-capture/legacy evidence. In absorption mode land project-owned material under `problem/` via `absorb`.
- Do not hand-edit `.assay/manifest.json`, `.assay/systems-registry.json`, or `.assay/adrs.json`; use the CLI.
- Do not edit, rename, or delete files under `intent/original/`. Record a corrected capture with `--supersedes` instead.
- Do not paraphrase intent while capturing it, and do not capture a whole transcript when one paragraph carries the request. Paraphrase in `promote`, not in `capture`.
- Do not use `intent capture --force` to work around a system whose intent authority is external; record it where the authority says, unless the user explicitly wants a local shadow copy.
- Do not treat a root `.trellis/` as `assay.trellis` state. The built-in plugin writes dynamic state only under `.assay/trellis/`; use native Assay ADR commands for decisions.
- Do not set two systems as `primary` simultaneously; use `system promote`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress and `knowledge add` to promote.
- Do not leave iterations open indefinitely; use `check --advisories` when you want a list of open plans.
- Do not silently rename or delete legacy folders.
- Do not copy AGPL or incompatible upstream source into our skill; extract patterns and document decisions instead.
- Do not leave an external reference without an analysis exit: adopt, reject, experiment, or ADR.
- Do not treat a frozen source as absorbed merely because it was copied; a freeze without an analysis exit is unfinished work.
- Do not run `source sync` as a routine sweep. Read the `Upstream` section of `status` and sync the sources it reports as moved.

## Positive rules (what "absorbed" actually means)

- When a frozen reference is meant to inform a decision, follow it with an analysis containing the observations needed by that decision. `absorb` opens a bound draft automatically; `reference add` deliberately does not.
- A living source MUST keep provenance and observation metadata. Use `source status`, `source log`, `source diff`, and `analysis new --for-source` instead of browsing `.assay/` manually; `major` source changes require revalidation before old conclusions are treated as fresh.
- A file existing does not prove analysis quality. Use `## Key observations` and `## Adopt`/`## Reject` when durable rationale matters; Assay records explicit close decisions instead of pretending a mechanical text check can establish quality.
- Closing an analysis (`analysis close --exit …`) is the action that records the decision and marks a bound living source observation `analysis_status: closed`. Until then the source material is open work.
- A frozen reference keeps a `reference.yaml` recording where it came from. `check --advisories` lists frozen directories that have none, with the `reference backfill` command to write one.
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
- `[warning]` — managed file modified by user, ADR frontmatter missing, contract file missing, or independent-git system without `.git`. With `--advisories`, also includes open iterations, frozen references with no `reference.yaml`, major source observations that may need revalidation, empty draft analyses, stale `.old/` adoption archives, pending queue entries, intent enabled in an unversioned private overlay, superseded systems that no supersedes chain points at, top-level directories the archetype does not declare, `analyses/references/` files with no `Status:` header, and an `AGENTS.md` managed block that no longer matches the archetype. Warnings never fail the check.
- `[missing]` — required directory or manifest absent.
- `[error]` — managed file missing from disk, registered system path missing, source observation records missing required fingerprint/manifest state, two primary systems, inconsistent ADR supersede links, or invalid donor persistence. **Exits non-zero.**

Workflow/content reminders are opt-in because they describe work state, not corruption. Structure, registry/index consistency, managed-record integrity, and donor persistence remain in the default check.

`status` opens with the archetype and its one-line description, then `Zones`: the directories that archetype declares, each with a file count and what belongs in it. Read the zones before placing a file — they are the workspace's own statement of where work goes, and they differ per archetype. After that it shows `Systems` (with primary marker, vcs, version, supersedes chain), a compact `Living sources` summary, an `Upstream` block naming each source that drifted and how many donor mappings the change reaches (add `--fetch` to compare remotes as well), `Decision records` suggestions for sources whose last change was graded `major` or `replacement`, a compact `Donor adoptions` summary when donor records exist, `Open iterations`, `Knowledge entries`, and `Run records (runs.jsonl)` where that file exists. Use `--json` for the same data machine-readably. For update and migrate, always run `--dry-run` first and review the plan before `--apply`. Dry-run commands must not create project files or project-registry records.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.assay/VERSION` and layout version.
- Whether migration was only planned or applied.
- Which reference/analysis/iteration/knowledge artifacts were produced.
- Which ADRs were created, accepted, superseded, deprecated, or left proposed.
- Which intent captures were recorded (with their systems), which were promoted into requirements or ADRs, and which are still unconverted requests.
- Registered systems and the current `primary`.
- **Content-completeness**: count of living sources and whether latest observations have provenance/fingerprints/manifests; count of frozen references carrying a `reference.yaml` vs missing one; count of open draft analyses and whether their `Key observations` are non-empty; whether `.old/` still contains un-migrated stamps. This is what distinguishes "files were created" from "content was actually absorbed".
- Any open iterations or unresolved reminders reported by `check --advisories`, when that audit was requested.
- Next recommended absorption, analysis close, iteration, or close step.
