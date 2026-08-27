---
name: assay-builder
description: "Use when building, adopting, updating, or analyzing a current Assay workspace through native Project, Task, Roadmap, Spec, Source, Analysis, Knowledge, System, or external Plugin metadata workflows."
---

# Assay Builder

Build and maintain an Assay evidence workbench — a versioned project layer that stores sources, analyzes them, converts validated patterns into our own systems, and iterates over time.

## Prerequisites

- Node.js >=22.13.0 and pnpm 11.3.0 (pinned by the repository)
- This skill lives inside the `assay` repo and runs the repo's CLI directly — there is no bundled copy. Install by cloning the repo and running the repo-root installer from the cloned repository; it builds the workspace and links this skill into the selected skills directory so it resolves back to the repo.
- Invoke via the skill-local launcher `scripts/assay.mjs`; it walks up to the repo and runs the built TypeScript CLI at `packages/assay-cli/dist/cli.js`. `dist/` is a build artifact (not committed) — the repo-root installer builds it, or build manually with `pnpm install && pnpm build`.
- When maintaining this repository itself, use the repo-root release scripts (`../../scripts/check.sh` on POSIX, `../../scripts/check.ps1` on Windows). They run the built CLI checks and the committed public-example gate.
- Read `references/cli-setup.md` for install, build, and invocation details. Use `references/cli-setup.zh.md` when Chinese setup instructions are needed.

## Evidence loop

```text
evidence in -> structured checks -> decisions -> knowledge growth
```

One-shot Templates instantiate that loop with different workspace structures. `study` uses Sources and analyses for external systems; `solve` uses objectives, inputs, attempts, and benchmarks; `explore` uses parallel approaches and trials. A custom Template is passed as an explicit YAML path to init or attach, expanded once, and not persisted. Open work can be closed explicitly where the CLI provides lifecycle commands, and durable findings can flow into `knowledge/`; Assay records those choices without mechanically judging the prose.

## CLI quick reference

Prefer the repo's CLI for all workspace operations — it preserves user files, writes a manifest, and keeps updates auditable. Invoke it from any working directory with the skill-local launcher (resolve `scripts/assay.mjs` relative to the skill root):

```bash
node <skill-root>/scripts/assay.mjs <command>
```

```bash
# Orientation — run prime once per session, explain before first use of an object
assay prime [--json]                         # object semantics + this workspace's state, one screen
assay explain <topic> [--json]               # workspace|project|task|roadmap|spec|source|adoption|analysis|knowledge|system

# Workspace lifecycle
assay init [target-dir] --name <project-name> [--template <name-or-yaml-path>]  # built-ins: study|solve|explore
assay template list | show <name-or-yaml-path>
assay adopt --dry-run                        # always dry-run first
assay adopt --apply --name <project-name> [--analyze]  # --analyze opens an adoption inventory analysis
assay check                                  # structure + persisted-record integrity
assay check --advisories                     # opt-in workflow/content reminders
assay status [--json] [--fetch]              # manifest-entry zones + systems + sources + upstream drift + counts
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

# External plugin metadata (host-owned execution only)
assay plugin register <descriptor.json> [--json]
assay plugin observe <observation.json> [--json]
assay plugin list [--json]
assay plugin check [--json]
assay plugin disable|enable <external-id> [--json]
assay plugin remove <external-id> [--json]

# Sources / analysis / knowledge
assay source add <repo-or-dir> [alias] [--branch <branch>]
assay source capture <alias> [--note <text>]
assay source import <alias> <dir-or-archive> [--note <text>]
assay source sync [alias] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--sync]
assay source status [alias]
assay source diff <alias> [--since <observation>]
assay source log <alias>

# Source references: link before you clone a second time
assay source link <target-workspace> <target-source> [--alias <local-alias>]
assay source link <target-source>            # clone registry resolves the home
assay source home <local-alias>
assay source unlink <local-alias>

# Source adoption: one record is one mapping
assay source adoption take <alias>:<source-path> --into <system>:<target-path> [--mode adapt|copy] [--note <text>] [--to <observation>] [--id <adoption-id>]
assay source adoption list
assay source adoption show <adoption>
assay source adoption remove <adoption>

assay analysis new "Title" [--for-source <alias>] [--observation <id>]
assay analysis close <path> --exit adopt|reject|experiment [--note ...]
assay knowledge add <type> "Title" [--from-analysis <path>]


# System registry
assay system register <path> [--vcs independent-git|embedded|none] [--primary] [--supersedes <names>]
assay system update <selector> [--path <path>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--primary] [--supersedes <names>]
assay system promote <selector>
assay system archive <selector> --dry-run | --apply
assay system list [--status primary|active|superseded|archived] [--json]
assay system show <selector>

# Explicit workspace index
assay workspace track [root] | discover <roots...> | list | forget <selector>
```


## Adopt an existing project

Use `adopt` when the current directory already contains a non-Assay project. Always run `--dry-run` first, review the plan, then `--apply`. The CLI archives root contents under `.old/<timestamp>/`, preserves `.git/`, and creates the standard scaffold.

For the full post-adoption workflow (inspect, analyze, register systems, confirm direction, move artifacts, validate), read `references/adoption-workflow.md`.

## Framework structure

Target projects use a fixed core plus one-shot Template output. The manifest persists the expanded paths, never Template identity; overlay resolves work folders under `.assay/`. Source and Analysis remain native lazy areas, while built-ins eagerly add `sources/` + `analyses/` (`study`), `problem/` + `intake/` + `attempts/` (`solve`), or `approaches/` + `trials/` (`explore`). For the full structure guide and managed receipt, read `references/framework-structure.md`.

## Native Task

Use `assay task` when one bounded outcome needs a durable identity across
sessions, agents, context compaction, or implementation attempts. Create the
Task at that boundary, not for every piece of work. If the intended outcome is
unchanged, keep using the same Task when an attempt restarts or ownership moves.

Climb the ladder before reaching for a native object. Work that repeats in
quantity — one contest problem, one book section, one dataset run — belongs in
plain directories inside a template area, where adding the hundredth costs
nothing. Promote one of them to a Roadmap item when that specific outcome needs
state the Project tracks, and create a Task only when the work itself needs a
durable identity that survives a session, agent, or attempt boundary. Three
hundred Tasks standing in for three hundred directories buys nothing and makes
every listing worse.

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

Any subdirectory you invent under `tasks/` is a legal navigation prefix:
`tasks/research/deep/task-0007-<slug>/` is the same Task as
`tasks/task-0007-<slug>/`. Resolution is recursive and the stable id remains the
only identity, so move a Task directory between prefixes with an ordinary `mv`
whenever the filing helps. Prefixes carry no schema, never appear in
`task.json`, and change nothing about bindings, relations, or roadmap
`task_refs`, which all reference ids. `create` always lands in the flat root;
organizing is a deliberate move afterwards. `tasks/archive/` is the one reserved
name and stays flat, so archiving a prefixed Task moves it to
`tasks/archive/<id>/`. The same id under two prefixes is a storage conflict, not
a choice.

`task list` and `task validate` answer different questions. `list` is discovery
plus storage health: it reads each Task envelope, so an unparseable `task.json`,
an id that disagrees with its directory, and one id filed twice still show up.
`validate` owns integrity, which means the lineage graph — a dangling or cyclic
relation target is reported there and nowhere else. Run `validate` when you need
to trust the graph; do not read a clean `list` as a sound one.

Both use partial-health output: valid rows stay in stdout/JSON while diagnostics
go to top-level `issues` (or a human `Task storage issues:` section), and the
command exits 1 when any issue exists. Use the valid rows for discovery, but do
not report the storage as healthy until the issues are repaired.

Keep roadmaps, specifications, and acceptance in the native Project. Use
`assay spec` for closed envelopes plus reader-owned specification prose,
and use explicit `spec promote` only with an independent clean body and the
Analysis or Task the body came from. Activation validates structure; it is not
approval or Project acceptance. Keep agent DAGs, dispatch, ownership, and
permissions in the host. Relay owns fork and promotion semantics. Keep product
learning and durable findings in analyses and knowledge.

## External plugin metadata

- `plugin register` validates and locks an independently packaged descriptor under `.assay/external-plugins.json` schema 1. It never imports, installs, activates, or executes the payload.
- `plugin observe` requires a concrete host version and rejects identity, integrity, host, exact-version, grant, surface, or ownership mismatches. Assay never resolves or deletes host locators.
- Disable, enable, and remove change only Assay control-plane records. Requested capabilities remain opaque host metadata and grant no native responsibility, Task, workspace, or execution authority.
- Manifest schema 4 carries no Plugin declarations or bindings. External Plugin state remains in its independent schema 1 metadata store, and core never installs or reconciles host payloads.
- Native Task owns durable Assay task identity and lifecycle. The host runtime owns dispatch, agent DAGs, execution permissions, and activation; do not alias or import another task store.


Assay 0.13 has no native product-Intent object or capability-module commands. A manually created `intent/` or `.assay/intent/` directory is generic unowned content: Assay does not parse, promote, rewrite, migrate, or delete it. Keep product requirements in native Specifications or reader-owned Project prose, and preserve verbatim external evidence in its authoritative source or an Analysis when appropriate.


## Systems and version control

Each System may be an independently version-controlled repository. Assay manages only the schema-3 **systems registry** (`.assay/systems-registry.json`), not System source or release identity. The registry map key is the exact Project-local selector. A file named `system.yaml` is ordinary user content: never ask Assay to create, refresh, validate, move, or delete it.

- `vcs: independent-git` — the System path is its own Git repository. Framework `check` observes the registered boundary but does not rewrite repository/package/README identity.
- `vcs: embedded` — system files live in the root repo directly.
- Exactly one system has `status: primary` at any time. Use `system promote` to switch; the previous primary becomes `superseded` automatically.
- Use `system update <selector>` to correct metadata for an existing record, for example `assay system update skill-creator --vcs independent-git --vcs-ref main` after a system was registered as `embedded` by mistake. Do not re-run `system register`; duplicate registration is intentionally rejected.
- Archive non-primary Systems with `system archive --apply`. Assay 0.13 performs a logical registry transition only; it never moves or deletes System bytes.

Never hand-edit `.assay/systems-registry.json`. For the full registry schema, vcs semantics, gitignore patterns, and migration notes for legacy layouts, read `references/systems-registry.md`.





## Update policy

Always run `update --dry-run` before applying. User-modified files are skipped by default; use `--create-new` for sidecar copies or `--force` only with explicit user consent. For change classification rules, conflict flags, and backup behavior, read `references/update-policy.md`.

If Assay reports a cutover error with an `assay-cutover:<observed>-><required>` locator, stop normal Assay mutation and follow [the canonical major-cutover handoff](../../docs/legacy-cutover.md).

## Workflow

1. Run `assay prime` first. It states what each native object is for, the rule most often broken for each, and the current workspace state; `assay explain <topic>` covers one object in depth. Then inspect the target folder and any supplied external repository.
2. Use `workspace list` for the explicit index or `workspace discover <parent-dir>` to locate and track current workspaces.

### Source evidence pipeline

The study-style flow `sources → analyses → systems + knowledge` is not a directory-transfer graph where "file exists = step done". Each step must produce content before it counts as complete:

```
source add <source> <alias>          # or: source link <workspace> <alias>, if it has a home
  → analysis new "Review" --for-source <alias>
  → fill ## Key observations / Adopt / Reject in the analysis   # content, not just a file
  → analysis close <path> --exit …   # records the decision exit, closes the loop
```

3. **Before adding, ask whether this material already has a home.** If another workspace tracks it, `source link <target-workspace> <target-source>` is the first choice and `source add` is the fallback: linking writes a pointer shell under `sources/<alias>/` and shares the one checkout, one observation ledger, and one `brief.md`, where a second `add` would start a competing record of the same upstream. Reads through a reference always show `ref -> <workspace>#<alias>`; writes (`sync`, `capture`, `import`, `switch`) land in the home, under the home's mutation coordination, and say the home's path before they start. `source home <alias>` answers where an alias actually lives. `source unlink <alias>` forgets the local name and touches nothing in the home — removing the Source itself is only possible in the workspace that owns it. If `source add` prints an advisory naming an existing home, that is this decision arriving late: prefer the link it suggests unless a separate record is genuinely wanted. A reference whose home moved is reported as `broken` and fails only on that alias; repair it by linking again at the new path, never by hunting for it manually.
4. **Add external evidence with `source add <repo-or-dir> [alias]`** when no home exists yet. The shape follows the material: a Git repository or URL becomes a tracked checkout in `sources/<alias>/checkout/`, and anything else is copied once into `sources/<alias>/content/`. There is no mode flag. The ledger is `observations/` — one cheap append record per look, carrying the date, the commit when there is one, a note, and any advisories. `captures/` holds explicit byte preservation, `materials/` stays user-owned, and diffs are derived rather than persisted.
5. **Pin evidence at the tier the decision needs.** Tier 0 is the default and costs nothing: the alias, the date, and the commit for a Git source. Tier 1 is identity — the commit and origin, or for copied content a tree hash computed on demand when an adoption or a decision cites it. Tier 2 is `source capture <alias>`, which copies the current bytes with an integrity hash and is the only routine command that hashes a tree. Reach for a capture when the bytes themselves have to survive, not on every look.
6. **Read upstream drift out of `status`, not out of a maintenance command.** The `Upstream` section compares each managed checkout against the commit its latest observation recorded, with no network, and names the Source adoption mappings a change reaches. `status --fetch` adds a remote comparison; a source it cannot reach is annotated and the command still exits 0. Run `source sync` when that section reports new upstream commits — and never as a routine habit.
7. **Sync checkout-backed Sources with `source sync [alias]`** when the external system changes. Sync never refuses because of local work: it fast-forwards what it can, records an `observed with local modifications` advisory when the checkout holds uncommitted changes, and records that the upstream could not fast-forward instead of rewriting anything. Git remains what protects the bytes. Copied content has no upstream to follow — replace it with `source import <alias> <dir>`, which captures the bytes it is about to replace first. Change classes record workflow meaning rather than imposing a universal gate: `same` writes an event only, `patch`/`normal`/`major` describe the observed delta, and `replacement` should usually become a new lineage instead of pretending it is a refresh.
8. **Record a Source adoption with `source adoption take`** when selected source material is carried into a registered system and should stay traceable across later updates. One record is one mapping — an intent that moved three paths is three `take` calls. `--note` is where the reason goes, `--mode adapt|copy` says whether the material was reworked or copied verbatim, and a tier-1 pin is recorded for free (commit and origin, or a content hash for copied material). The record is traceability, not an approval pipeline: there is no inspection, evidence, or decision workflow, and a decision belongs in `analysis close --exit`.
9. **Open a source-bound analysis** with `analysis new "Title" --for-source <alias> [--observation <id>]`. Both content modes use the same resolver. Analysis close changes only the Analysis; Source observations remain immutable. When an analysis closes on `adopt` or `reject`, consider recording a tier-1 pin for what it decided about — a suggestion, never a requirement.
10. **Fill the analysis body when the decision needs durable rationale**: complete `## Key observations` plus the relevant decision section (`## Adopt`, `## Reject`, or `## Next step`) with real content drawn from the source. `check --advisories` can list empty drafts; `analysis close` trusts the caller's explicit exit and does not block on section-content heuristics.
11. Convert promising findings into a candidate pattern under `analyses/patterns/`. Create a native Task only when future bounded work needs a complete Goal, Acceptance Criteria, and durable identity.
12. Register active systems with `system register` (use `--primary` and `--vcs independent-git` when appropriate). If a registered System's metadata is wrong, use `system update` to correct `vcs`, `vcs_ref`, version, path, supersedes, or primary status. Path update is registry rebind only.
13. Run `update --dry-run` before applying framework upgrades.

### Adoption with direction

When adopting an existing project, `adopt --apply --analyze` opens an adoption inventory analysis listing every archived entry with a suggested destination. The default posture for absorption-mode and adoption work is: **propose a concrete move plan first (as a diff/preview or the inventory table), then apply on user confirmation** — not "stop and wait after archiving". Move archived entries into the new structure once the direction is clear; `check --advisories` can report a lingering `.old/` when that reminder is useful.

## Anti-rules

- Do not overwrite existing user files by default.
- Do not hand-edit native `task.json` or `.assay/task-contexts.json`; edit `prd.md` directly and use `assay task` for machine metadata, lifecycle, relationships, and bindings.
- Do not create a new Task for another attempt at the same bounded outcome, and do not write `handoff.md` after every update. Checkpoint only at a real continuation boundary.
- Do not treat Task creation, binding, relationships, or `finish` as permission, assignment, project acceptance, Git closeout, roadmap state, or Relay promotion.
- Do not put external evidence under `systems/`; add it as a Source under `sources/<alias>/`.
- Do not `source add` material another workspace already tracks. Link it. Two clones of one upstream means two ledgers and two answers to what upstream did.
- Do not hand-write a reference shell with a `branch`, `revision`, or `pin` field, or hand-repair a broken one by editing files under someone else's `sources/`. A reference names a home and the home holds the state; repair is `source link` again or `source unlink`.
- Do not expect a broken reference to fix itself. Nothing scans neighbouring directories and nothing rebinds automatically.
- Do not set two systems as `primary` simultaneously; use `system promote`.
- Do not let `knowledge/` become an inbox; use `analyses/` for work-in-progress and `knowledge add` to promote.
- Do not silently rename or delete legacy folders.
- Do not copy AGPL or incompatible upstream source into our skill; extract patterns and document decisions instead.
- Do not treat a Source as adopted merely because its bytes were copied or captured; a copy without an Analysis exit is unfinished work.
- Do not run `source sync` as a routine sweep. Read the `Upstream` section of `status` and sync the sources it reports as moved.

## Positive rules (what "absorbed" actually means)

- When copied content is meant to inform a decision, follow it with a source-bound Analysis containing the observations needed by that decision.
- Record what this decision needs, not everything recordable. A Source's observation ledger exists so a later reader can tell what was looked at and when; read it with `source status`, `source log`, `source diff`, and `analysis new --for-source` rather than browsing `.assay/` by hand. Source observations never store Analysis status, so decide explicitly when a changed Source needs a new Analysis.
- A file existing does not prove analysis quality. Use `## Key observations` and `## Adopt`/`## Reject` when durable rationale matters; Assay records explicit close decisions instead of pretending a mechanical text check can establish quality.
- Closing an analysis (`analysis close --exit …`) records only the Analysis decision; it never rewrites Source observations.
- In absorption mode, the source IS the project — do not treat official materials as external references. Land them in `problem/`.
- For adoption and absorption, propose the concrete destination first, then apply on confirmation. Do not stop after archiving.

## Validation

After any init, attach, adopt, update, or convert operation:

```bash
assay check
assay status
```

Run `assay check --advisories` separately when workflow reminders are useful.
`check` reports four severity levels:

- `[ok]` — directory or managed file present and unchanged.
- `[missing]` — required directory or manifest absent.

Workflow/content reminders are opt-in because they describe work state, not corruption. Structure, registry and persisted-record consistency, managed-record integrity, and Source adoption record integrity remain in the default check.

`status` opens with the exact manifest/layout and native Project, then `Zones`: directory entries with file counts and purposes. Read the zones before placing a file. After that it shows `Systems` (with primary marker, vcs, version, supersedes chain), a compact `Sources` summary, an `Upstream` block naming each source that drifted and how many Source adoption mappings the change reaches (add `--fetch` to compare remotes as well), a compact `Source adoptions` summary counting mappings, the systems they reach, and how many carry a pin, `Knowledge entries`, and `Run records (runs.jsonl)` where that file exists. Use `--json` for the same data machine-readably. Run `update --dry-run` before apply; dry-run commands must not create project files or workspace-index records.

## Final response checklist

Report:

- Target root and CLI command used.
- Created/updated/skipped/conflicted files.
- Current `.assay/managed-files.json` and layout version.
- Whether conversion or adoption was only previewed or applied.
- Which Source, Analysis, Task, or Knowledge artifacts were produced.
- Registered systems and the current `primary`.
- **What was actually evaluated, not just created**: which Sources were read and what their latest observations show; how many draft analyses are still open and whether their `Key observations` say anything; whether `.old/` still holds un-migrated entries. Report the evidence the decision rested on, not an inventory of every field Assay can store.
- Any unresolved reminders reported by `check --advisories`, when those were requested.
- Next recommended absorption, Analysis close, Task, or Knowledge step.
