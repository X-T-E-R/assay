# Commands

Run workspace commands from inside an Assay workspace. Commands discover the workspace by looking for `.assay/manifest.json`. Pass `--root <dir>` to operate on another workspace. Pre-0.7 workspaces fail closed with a cutover locator and require a separate external tool.

## Workspace lifecycle

```bash
assay init [target-dir] --name <project> --archetype <name> [--plugin <id...>] [--git] [--force] [--create-new] [--no-track] [--no-agents]
assay attach [--root <dir>] --name <project> --archetype <name> [--plugin <id...>] [--privacy private|private-git|tracked] [--no-track] [--no-agents]
assay convert --to standalone --target <dir> [--move | --copy] [--no-keep-overlay]
assay check [--advisories] [--root <dir>]
assay status [--root <dir>] [--json] [--fetch]
assay update [--root <dir>] [--dry-run] [--agents] [--force | --skip-all | --create-new] [--no-track]
assay archetype [--root <dir>] [--json]
assay archetype list [--root <dir>] [--json]
```

`init` creates a standalone workspace: Assay state in `.assay/`, work folders at the root. `attach` creates an overlay inside an existing product repository: everything Assay-owned lives under `.assay/`, product files stay where they are, and product Git ignores `.assay/` by default. `convert --to standalone` detaches an overlay into a sibling standalone workbench without moving the product repo.

`--plugin assay.intent` installs the intent module after a successful `init` or
`attach`. The legacy `--plugin assay.trellis` option installs its workspace
runtime under `.assay/trellis/`; it has no external sidecar preflight. Both
remain options on the existing lifecycle verbs, not a third setup operation.

`init`, successful `update`, and successful `adopt --apply` write a user-local project registry under `~/.assay/projects` by default. Use `--no-track` on those commands, or set `ASSAY_NO_TRACK=1`, to skip registry writes. The `assay projects` commands manage registry metadata only; they never delete workspace files.

`init` and successful `adopt --apply` also add a short Assay-managed block to root `AGENTS.md` by default. Use `--no-agents` on those commands to skip it. Ordinary `assay update` refreshes the block only when it already exists; `assay update --agents` creates or re-enables it.

If `AGENTS.md` contains incomplete `<!-- ASSAY:START -->` / `<!-- ASSAY:END -->` markers, Assay leaves the file unchanged and reports the malformed block so you can fix or remove it manually.

`assay check` validates required structure, registries, managed-file state,
source observation integrity, and donor persistence. It exits non-zero
only for missing required structure or invalid persisted state. Add
`--advisories` to request non-blocking workflow reminders such as unfinished
draft analyses, pending queue entries, lingering
adoption archives, frozen references with no `reference.yaml`, and major source
changes that have not been re-reviewed.

`--advisories` also reports placement: a top-level directory the archetype does
not declare, an `analyses/references/` file with no `Status:` header, and an
`AGENTS.md` managed block whose directory table no longer matches the
archetype. Writing straight into a directory instead of going through a command
is normal usage, so these are reminders and never failures.

`assay status` prints the workspace's zones — the directories its archetype
declares — each with a file count and the archetype's own statement of what
belongs there, under a header naming the archetype and its description. A
directory Assay's layout defines but the archetype does not declare is listed
too when it holds files, so nothing with content becomes invisible. `--json`
emits the same data, zones and purposes included.

### Upstream drift in `status`

When the workspace has living sources, `status` adds an `Upstream` section
answering the two questions a source exists to raise — did it move, and does
that reach anything adopted from it:

```text
Upstream
  - qwen-agent   3 new upstream commits   affects 2 donor mappings
  - langgraph    local checkout modified (1 uncommitted file); not recorded — preserve or discard it before the next sync
  - autogen      no change
Next: assay source sync qwen-agent
```

- Without `--fetch` the comparison is local and free: the managed checkout's
  `HEAD` and working tree against the commit the latest observation recorded.
  This is what makes a hand-edited checkout visible; previously only
  `source sync` noticed, and it noticed by refusing.
- A checkout that is not a Git repository reports `not checked (no cheap
  signal)`. Full content fingerprinting stays in `sync`.
- `--fetch` also compares the remote tip. Failures — offline, expired
  credentials, a deleted remote — annotate that source with `upstream not
  checked this run` and leave the exit code at 0.
- When donor adoptions exist, the changed paths are intersected with their
  source locators, so the line says how many adopted mappings the change
  reaches.
- `Next:` appears only for an upstream move, which is the case `source sync`
  resolves. A drifted or modified checkout is deliberately refused by `sync`, so
  it is reported rather than pointed at a command that would fail.

## Native Task records

```bash
assay task create --title <text> [--description <text>] [--name <display-slug>] [--creator <name>] [--assignee <name>] [--priority <priority>] [--relation <type:id...>] [--context <key>] [--root <dir>] [--json]
assay task show <id> [--root <dir>] [--json]
assay task list [--status active|paused|done|cancelled|superseded] [--archived live|archived|all] [--limit <n>] [--cursor <cursor>] [--root <dir>] [--json]
assay task status <id> <active|paused|done|cancelled|superseded> [--expected-revision <n>] [--root <dir>] [--json]
assay task checkpoint <id> --from <handoff.md> [--expected-revision <n>] [--root <dir>] [--json]
assay task finish <id> [--expected-revision <n>] [--root <dir>] [--json]
assay task archive <id> [--root <dir>] [--json]
assay task bind <id> --context <key> [--rebind] [--root <dir>] [--json]
assay task clear --context <key> [--root <dir>] [--json]
assay task current [--id <id>] [--context <key>] [--root <dir>] [--json]
assay task context [id] [--context <key>] [--root <dir>] [--json]
assay task relations <id> (--relation <type:id...> | --clear) [--expected-revision <n>] [--root <dir>] [--json]
assay task validate [id] [--root <dir>] [--json]
```

`assay task` keeps one bounded outcome identifiable across sessions, agents,
context compaction, and repeated attempts. It is native and needs no plugin or
capability module. Standalone workspaces store each record in
`tasks/<stable-id>/`; overlays use `.assay/tasks/<stable-id>/`.

`create` takes scalar options rather than a JSON payload and assigns the next
`task-0001-<slug>` stable id.
`--description` seeds the initial PRD but does not make `task.json` the
prose authority. Repeat `--relation <type:id>` to create several relationships.
`checkpoint --from` reads UTF-8 Markdown directly and replaces the Task's
optional `handoff.md`; `--expected-revision` lets writers fail instead of
overwriting a concurrent metadata or checkpoint change.

When `create --context` finds that the context is already bound, the Task stays
created but the binding fails. Use the returned stable id with `bind --rebind`
instead of running `create` again.

`--name`, `--creator`, `--assignee`, and `--priority` are display or
compatibility metadata. They neither replace the stable id nor establish host
ownership or permission.

Every Task directory requires `task.json` and `prd.md`. `task.json` is the
machine envelope and compatibility metadata; reader-facing goals, scope,
task-level success checks, and links to governing acceptance belong in
`prd.md`, which people and models edit directly. Project acceptance itself
remains with the native Project.

Optional `design.md` and `research/` hold Task-local material. Add
`handoff.md` only at a real continuation boundary. It is a replaceable
current-state checkpoint, not a diary or a second PRD.

A checkpoint must contain these exact headings in order:

```markdown
# Current State
## Completed Outcomes
## Working State
## Verification Evidence
## Next Action
## Open Blockers and Decisions
```

The lifecycle statuses are `active`, `paused`, `done`, `cancelled`, and
`superseded`. `blocked` and `partial` are handoff facts, not terminal statuses.
`finish` marks the Task `done`; it does not archive files, change Git, record
project acceptance, update a roadmap, or promote Relay state. `archive` is a
separate operation and moves a terminal Task to `tasks/archive/<id>/`.
Terminal statuses do not reopen through `status`.

Current resolution is explicit id, then an exact host-context binding, then
none. Use `current --id <id>` or `context <id>` for the explicit case; use
`--context <key>` to resolve an exact binding. Bindings live in
`.assay/task-contexts.json`. There is no fallback based on active count,
creation time, or title. Multiple Tasks and duplicate titles are valid; use
stable ids. Replacing a different existing binding requires `bind --rebind`.

`list` isolates damaged storage instead of hiding healthy siblings. It emits
valid, filtered, paginated Task rows and also reports invalid or duplicated
storage entries as top-level `issues`. JSON entries retain the `TASK_*` code,
path, and live/archive location. Human output appends a `Task storage issues:`
section after the valid rows.

When any issue exists, `list` still writes this partial result to stdout but
exits with status 1. Callers must inspect both the rows and diagnostics rather
than treating the response as an empty list.

Relationships use `contributes_to`, `continues`, or `supersedes`. They preserve
lineage only: no status, permission, acceptance, completion, or host binding
propagates through them.

`relations` replaces the full relation set; use `--clear` to remove it
explicitly. Self-relations, duplicate pairs, missing targets, and directed
cycles are rejected. `validate` checks Task files, relationships, and context
bindings without changing them.
`assay check` includes the same Task integrity checks in its workspace-wide
report.

Roadmaps, specifications, and acceptance remain with the native Project. Agent
DAGs, dispatch, ownership, and execution permissions remain with the host.
Relay owns fork and promotion semantics. See [Task records](task.md) for the
file contract and operating boundaries.

## Native Roadmap items

```bash
assay roadmap create --title <text> [--root <dir>] [--json]
assay roadmap show <id> [--root <dir>] [--json]
assay roadmap list [--state candidate|committed|realized|retired] [--horizon now|next|later|unscheduled] [--task <task-id>] [--archived live|archived|all] [--limit <n>] [--cursor <id>] [--root <dir>] [--json]
assay roadmap update <id> [--title <text>] [--state <state>] [--horizon <horizon>] [--order <n-or-null>] [--depends-on <id...> | --clear-depends-on] [--superseded-by <id...> | --clear-superseded-by] [--expected-revision <n>] [--root <dir>] [--json]
assay roadmap link-task <id> --task <task-id> [--expected-revision <n>] [--root <dir>] [--json]
assay roadmap unlink-task <id> --task <task-id> [--expected-revision <n>] [--root <dir>] [--json]
assay roadmap realize|retire <id> [--expected-revision <n>] [--root <dir>] [--json]
assay roadmap archive <id> [--root <dir>] [--json]
assay roadmap validate [id] [--root <dir>] [--json]
```

New items use `roadmap-0001-<slug>` ids. A title can be renamed and duplicate
titles are valid; the full id never changes. Each item has independent state
and horizon fields. `realized` and `retired` are terminal, and only terminal
items can move to `roadmap/archive/<id>/`.

Roadmap Task links are canonical only in `item.yaml.task_refs`. Linking checks
the exact Task id in live or archived native Task storage; unlinking can repair
a dangling reference after the Task has disappeared. Task and Roadmap
lifecycle commands never update each other. `list`, `validate`, and `assay
check` report malformed items, graph errors, and unresolved Task references
without hiding healthy siblings. See [Roadmap items](roadmap.md).

## Specifications

```text
assay spec create --title <text> --scope project|system:<id> --strength required|recommended [--root <dir>] [--json]
assay spec promote --title <text> --scope project|system:<id> --strength required|recommended --body <file> (--from-analysis <analyses/...> | --from-task <task-id> --task-file prd.md|handoff.md|design.md|research/*.md) [--root <dir>] [--json]
assay spec show <id> [--root <dir>] [--json]
assay spec list [--state draft|active|retired] [--scope project|system:<id>] [--strength required|recommended] [--archived live|archived|all] [--limit <n>] [--cursor <id>] [--root <dir>] [--json]
assay spec update <id> [--title <text>] [--scope project|system:<id>] [--strength required|recommended] [--expected-revision <n>] [--root <dir>] [--json]
assay spec activate|retire <id> [--expected-revision <n>] [--root <dir>] [--json]
assay spec replace <old-id> --with <active-successor...> [--expected-revision <n>] [--root <dir>] [--json]
assay spec archive <id> [--root <dir>] [--json]
assay spec validate [id] [--root <dir>] [--json]
```


## Workspace plugins and reconcile

```bash
assay plugin add <id> [--root <dir>]
assay plugin register <descriptor.json> [--root <dir>] [--json]
assay plugin observe <observation.json> [--root <dir>] [--json]
assay plugin disable|enable <external-id> [--root <dir>] [--json]
assay plugin remove <external-id> [--root <dir>] [--json]
assay plugin list [--root <dir>] [--json]
assay plugin check [--root <dir>] [--json]
assay reconcile [--root <dir>] [--plugin <id...>] [--dry-run | --apply] [--json]
```

`assay.intent` (alias: `intent`) contributes the additive `intent` capability.
`plugin add` declares it in `.assay/manifest.json`, creates only missing intent
scaffold files, and writes an installation receipt to `.assay/plugins.json`.
Existing files are never overwritten.

`plugin register` is the separate, declaration-only path for an independently
packaged external descriptor. Assay validates and locks the descriptor and its
exact payload reference in `.assay/external-plugins.json`; it does not import,
install, activate, or execute the payload. Qualified external IDs cannot use
the reserved `assay.*` namespace. A descriptor declares one or more target
hosts; a target carries an exact version only when the adapter knows one. The
payload provenance carries an SPDX identifier and authoritative license URL.
Payload integrity is either exact lowercase `sha256:<64-hex>` or npm-style
`sha512-<64-byte-base64>`, and its ref ends in an exact `@version` or
`#version` token.

State ownership distinguishes safe Assay-relative paths from opaque symbolic
host locators, which Assay never resolves or deletes. `plugin observe` imports
one concrete host/version report and rejects identity, descriptor/payload
integrity, undeclared host, known exact-version, scope, surface, or ownership
mismatches. Until that report exists, list/check show host installation and
activation as unobserved and health as unverifiable. Observations require an
RFC 3339 timestamp with timezone; `active`, `healthy`, or `unhealthy` states
require `installed`, while a `not-installed` report must remain inactive and
unverifiable. List output keeps the concrete observed host/version and health
aligned across its generic and external status fields. Disable/enable changes
only Assay contribution state. Remove deletes only Assay's descriptor record
and preserves package and host state.

`assay.trellis` (alias: `trellis`) is the legacy built-in
`workspace-runtime` plugin. Native Tasks do not delete, rewrite, import, or
automatically migrate existing Trellis state.

Its protocol version, per-plugin receipt `state_version`, and dedicated runtime
state schema are all exactly `1`. Dynamic task state is stored only in
`.assay/trellis/`; no Trellis CLI or root `.trellis/` sidecar is used. It
declares task-store, context-provider, and host-hook-registration runtime

```bash
assay trellis task create --title "Implement slice" [--session-id <id>] --json
assay trellis task current [--session-id <id>] --json
assay trellis task complete|cancel|list|show|archive ... --json
assay trellis session start|current|end|rebind ... --json
assay trellis journal append|list|show ... --json
assay trellis config show|set ... --json
assay trellis channel create|send|read|watch-once|cursor|repair ... --json
assay trellis channel lease acquire|renew|release ... --json
assay trellis worker register|claim|heartbeat|complete|stop|list ... --json
assay trellis mem list|show|search|context ... --json
assay trellis migrate legacy plan|apply|rollback|cleanup ... --json
assay trellis protocol --json
assay trellis context --host codex [--session-id <id>] --json
assay trellis hook install --host codex [--dry-run | --apply] --json
assay trellis hook legacy plan|apply|restore --host codex --json
assay plugin disable|uninstall assay.trellis [--purge --yes] --json
```

`ASSAY_TRELLIS_SESSION_ID` and then `CODEX_SESSION_ID` are session-id fallbacks
for the ordinary API. The Codex SessionStart adapter reads hook stdin first and
falls back to `CODEX_THREAD_ID`.
When session pointers disagree, unscoped `current` and `context` fail instead
of selecting the newest task. The Codex hook installer edits only the
proven-owned command entry in project `.codex/hooks.json`, preserves neighboring
hooks, and registers an absolute Node + Assay CLI invocation of
`trellis context --host codex --hook-adapter`
directly; it does not copy a script. Ownership marker and fingerprint live in
`.assay/trellis/state.json`. A matching unreceipted canonical entry is adopted;
modified or duplicated candidates fail as conflicts without being removed.

All mutation domains share reparse-safe workspace paths, PID-aware stale locks,
atomic JSON/JSONL replacement, and a recoverable v1 WAL. Existing `state.json`
and task-record byte contracts stay strict v1; every added domain file declares
its own `__schema: 1`. Tasks close current pointers on terminal transitions.
Channel sequence numbers and cursors are monotonic, idempotency keys are durable,
and active leases are unique until release or expiry. External workers register
and drive this CLI state machine; Assay does not claim to spawn a provider.

`trellis hook legacy plan` recognizes only the two v1 legacy writer groups
(`UserPromptSubmit` workflow-state injection and `SubagentStart` Trellis-subagent
context injection) with exact event, matcher, command, and group structure.
`apply` removes only those exact groups under the project hook lock, using
whole-file hash and identity CAS, an atomic replacement, a backup, and a durable
receipt. Modified, duplicated, ambiguous, reparse, hardlink, or concurrently
changed hook files fail closed. `restore` is explicit and requires the exact
receipted post-scrub file; later neighboring edits are preserved by refusal,
never overwritten. The current Assay-owned SessionStart hook is not a legacy
candidate.

`trellis mem` is bounded and read-only over `~/.codex/sessions` or an explicit
fixture root; it never ingests transcripts. Legacy migration reads explicit
roots, preserves sources, records hashes/provenance/identity/backups, rejects
rollback after subsequent target writes, and requires `--yes` for cleanup. An explicitly
supplied absolute `--channel-root` may be outside the workspace; it is a strictly
read-only source with canonical-root, reparse, hardlink, opened-handle identity,
containment, enumeration, item-size, and total-byte checks. Every converted or
archived target and receipt remains under the bound workspace `.assay/trellis`.
Unknown or malformed records are archived rather than silently discarded, and
apply revalidates the complete source set against its plan before committing.

Plugin disable/uninstall preserves `.assay/trellis` by default. Disable keeps a
manifest declaration marked `enabled: false`, while uninstall removes the
declaration. Purge is uninstall-only, requires `--purge --yes`, validates a
full backup first, and records recoverable lifecycle phases outside the runtime
before deletion.

`reconcile` is state convergence for an existing Assay workspace. It compares
the desired plugin declarations, legacy archetype/capability declarations,
installation receipts, and filesystem or provider state. Its actions are
`install`, `adopt`, `repair`, `refresh`, `noop`, and `blocked`. `refresh`
updates only Assay's recorded provider observations. It is a dry-run by
default; `--apply`
is required to write. `--plugin` filters plugins the workspace already desires
and does not install a new one.

A complete workspace created with the legacy `assay capability add intent`
path is adopted by writing a receipt only. An incomplete scaffold is repaired
by creating missing files only. Reconcile never creates a workspace, changes
its standalone/overlay mode, rewrites intent captures, removes declarations,
or purges orphaned receipts. Re-running `--apply` after convergence is an exact
no-op: it does not refresh timestamps or append another event.

Responsibility bindings remain distinct from capability contributions. The
legacy `federated-provider` declaration/receipt and removes its obsolete

## Attach an existing repository

Use `attach` when a product repository already exists and its root should remain the primary system. Assay writes one `.assay/` folder, registers the repo root as the primary system, and leaves tracked product files alone.

```bash
cd /path/to/existing-repo
assay attach --name ExistingRepo --archetype study --privacy private
```

Default privacy is `private`: Assay appends `/.assay/` to the repo-local `.git/info/exclude`, so `.assay/` never enters product commits. `private-git` does the same and also initializes a separate Git repository inside `.assay/` so Assay state gets its own history. `tracked` opts into committing `.assay/` with the product repo; this is never the default because it puts research material in product PRs.

`attach` does not write root `README.md`, root `.gitignore`, or root `AGENTS.md`. Tracked product files stay untouched.

## Convert overlay to standalone

Detach an overlay into a sibling standalone workbench without moving the product repo:

```bash
cd /path/to/existing-repo
assay convert --to standalone --target ../existing-repo-assay
```

The new workbench hoists `.assay/references` to `references`,
`.assay/analyses` to `analyses`, `.assay/tasks` to `tasks`,
`.assay/project` to `project`, and so on. Assay state travels
with it, including `.assay/task-contexts.json` and the legacy
`.assay/trellis/` runtime state.

Task and native Project directories are copied or moved without merging.
Conversion refuses a non-empty target `tasks/` or `project/` before
writing any target state. The original product repo is registered as the
primary independent system by relative path (`../existing-repo`).

Use `--move` to move instead of copy. `--no-keep-overlay` removes the emptied
`.assay/` from the source and requires `--move`; with a copy the overlay still
holds that state and the request is refused. The product repo and its `.git/`
are never modified.

`assay update` follows the workspace layout. In an overlay workspace, managed templates are written under `.assay/`, and root `README.md`, `.gitignore`, and `AGENTS.md` are never created or replaced — including with `--force`.

## Sources, analyses, and knowledge

```bash
assay source add <repo-or-dir> [alias] [--root <dir>] [--branch <branch>] [--capture checkout|archive]
assay source sync [alias] [--root <dir>] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--root <dir>] [--sync]
assay source status [alias] [--root <dir>]
assay source diff <alias> [--root <dir>] [--since <observation>]
assay source log <alias> [--root <dir>]
assay absorb <source-dir> [--name <name>] [--root <dir>] [--as problem|intake]
assay reference add <source-dir> <name> [--root <dir>]
assay reference backfill <path> [--source <origin>] [--root <dir>]
assay analysis new <title> [--root <dir>] [--for-source <alias>] [--observation <id-or-path>] [--for-reference <path>]
assay analysis close <path> --exit adopt|reject|experiment [--note <note>] [--root <dir>]
assay event capture --kind observation|analysis|decision|gotcha|note --text <text> [--root <dir>]
assay knowledge add <type> <title> [--from-analysis <path>] [--root <dir>]
```

Each living source stores its observation ledger flat under `references/<alias>/` as `observations/`, `manifests/`, `comparisons/`, and `captures/`.

`analysis close` records the caller's explicit exit, updates bound source
metadata, and writes an event. It does not block on section-content heuristics.
Use `assay check --advisories` before closing when unfinished-draft reminders
are useful.

`reference add` writes a `reference.yaml` recording where the frozen material
came from and when. `reference backfill` writes that file for a frozen
directory that has none — a freeze made by hand, or by a version of Assay that
predates the case file. It never overwrites provenance that is already there,
and `check --advisories` prints the exact command for each directory missing
one.

## Donor adoption

Use donor commands when selected material from a living source has been
implemented, adapted, or otherwise carried into a registered target system:

```bash
assay donor take <alias>:<source-path> --into <system>:<target-path> [--mode adapt|copy] [--to <observation>] [--id <adoption-id>] [--title <title>] [--root <dir>] [--json]
assay donor register --file <definition.json|yaml> [--root <dir>] [--json]
assay donor update <adoption> --file <definition.json|yaml> [--root <dir>] [--json]
assay donor list [--root <dir>] [--json]
assay donor show <adoption> [--root <dir>] [--json]
assay donor status [adoption] [--target <id>] [--root <dir>] [--json]
assay donor inspect <adoption> --target <id> [--to <observation>] [--root <dir>] [--json]
assay donor evidence add <adoption> <inspection> --file <evidence.json|yaml> [--root <dir>] [--json]
assay donor verify <adoption> <inspection> [--root <dir>] [--json]
assay donor decide <adoption> --target <id> --outcome accept|reject|defer [--inspection <id>] [--to <observation>] [--reason <text>] [--root <dir>] [--json]
assay donor history <adoption> [--target <id>] [--root <dir>] [--json]
assay donor rollback record <adoption> --to-decision <id> [--reason <text>] [--root <dir>] [--json]
```

`take` covers the common case — one source path carried into one system path —
by synthesizing and registering the definition `--file` would have contained.
Both arguments are `<name>:<path>` split at the first colon, with paths relative
to the source observation and the registered system. Use `--file` for several
mappings, several targets, or required evidence.

`inspect` captures source and target direct-change facts. It is optional:
`decide` without `--inspection` captures the current snapshots inside the
decision operation, and `assay status` answers "did the source change, and does
it reach this adoption" without any inspection at all. Evidence is advisory by
default and blocks `accept` only when the definition explicitly marks it
`required`.

Donor records live under `.assay/donors/`. They do not edit target files,
execute target tests, create commits, or restore revisions. See
[Donor Adoption](donor-adoption.md) for the definition schema, baseline model,
and integrity behavior.


```bash
assay system register <path> [--root <dir>] [--name <name>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--primary] [--supersedes <names>] [--intent-authority inline|external|none] [--intent-pointer <pointer>]
assay system update <selector> [--root <dir>] [--path <path>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--contract-file <path> | --no-contract-file] [--primary] [--supersedes <names>] [--intent-authority inline|external|none | --no-intent-authority] [--intent-pointer <pointer>]
assay system promote <selector> [--root <dir>]
assay system archive <selector> [--root <dir>] [--dry-run | --apply]
assay system list [--root <dir>] [--status primary|active|superseded|archived] [--json]
assay system show <selector> [--root <dir>] [--json]
assay projects
assay projects list [--json] [--all] [--status active|missing|uninstalled]
assay projects scan <roots...> [--json]
assay projects show <selector> [--json]
assay projects forget <selector>
assay projects prune [--dry-run] [--json]
```

Use `system register` only for first-time registration; it rejects duplicate names so accidental re-registration is visible. Use `system update <selector>` to correct metadata on an existing record, such as changing `vcs` from `embedded` to `independent-git` and setting `--vcs-ref main`. Omitted update fields are preserved. `--primary` uses the same one-primary behavior as `system promote`, and archived systems are read-only.

A Spec may use `system:<exact-registered-name>` as its scope, but the registry
remains the System authority. System update, promote, and archive never change
Spec state or bytes; Phase 1 adds no `spec_refs` to System records.

`--intent-authority` records where a system's product intent is authoritative:
`inline` (the default when the field is absent) means this workspace owns it,
`external` names another home through `--intent-pointer`, and `none` means the
system deliberately keeps no intent record. `assay intent capture` refuses to
write for `external` and `none`. The registry is the machine-readable home; the
sidecar contract mirrors the field only when `register` generates the contract,
so a later `system update` leaves an existing contract untouched, and the root
contract written by `assay attach` does not carry the field at all.
`system update --no-intent-authority` clears the field back to the default.

The built-in archetypes are `study`, `solve`, and `explore`. Use `assay archetype list` to see built-ins plus custom YAML archetypes from the current project and `~/.assay/archetypes`.

`research` is the old name of `study` and still loads: a manifest that records
it resolves to `study`, and `assay update` rewrites the manifest to the current
name. An archetype file you provide under that name takes precedence over the
alias.

`science`, `evaluation`, and `library` were removed in 0.4.0. Asking for one by
name fails with a message that names the removal and what to use instead. A
workspace whose manifest still records one keeps working: `check` and `status`
report the base structure and say in one line why the archetype's own
directories are missing from the report. To keep a removed shape, copy its
directories into your own archetype YAML under `.assay/archetypes/`.

## Product intent

Intent records what was actually asked for, kept separate from what was later built. It is an optional capability module; enable it with `assay plugin add assay.intent`. The older `assay capability add intent` path remains compatible.

```bash
assay intent capture [--text <text> | --file <workspace-relative-path>] [--system <name>] [--source <text>] [--supersedes <ids>] [--force] [--root <dir>]
assay intent promote <capture> --to requirement [--title <title>] [--root <dir>]
assay intent list [--system <name>] [--include-lineage] [--json] [--root <dir>]
```

`capture` writes `intent/original/<YYYYMMDD>-<sha256:12>.md` holding the text verbatim, plus the resolved system name, the full SHA-256 of the body, and the capture time. `--file` is resolved relative to the workspace root and refuses to leave it; pass text from elsewhere with `--text`.

Captures are append-only:

- Capturing identical text again is a no-op and writes no second record. `--source` and `--supersedes` passed to that repeat call cannot be applied to the record that already exists, so the command names them as ignored instead of reporting a change it did not make.
- Capturing identical text against a different system, or with a different shadow marking, fails. A capture is scoped to one system, and letting the second call succeed would leave the text scoped to the first one.
- `--supersedes` takes recorded capture ids. An id that is not one is refused and named, so a correction chain never points at a capture the workspace does not have.
- Capturing text whose record was edited after it was written fails, naming the recorded and current digests. Restore the file, or record the corrected wording as a new capture with `--supersedes <capture-id>`.
- `intent list` reports a record that no longer matches what was recorded as `[modified after recording]`, or `[unreadable record]` when it no longer parses at all, and keeps listing every other capture. The marker is in `--json` output as an `integrity` field.

Every capture is scoped to one registered system. `--system` accepts a name or unique prefix and defaults to the current primary; the resolved name is written into the record, so a capture keeps naming the system it was about after `system promote` moves the primary pointer. `intent list --system <name> --include-lineage` follows the registry `supersedes` chain so captures made against a replaced system stay visible.

If the named system records `intent_authority: external` or `none`, `capture` refuses and prints the pointer. `--force` records the text anyway, marked `shadow: true` in the record and flagged in `intent list`, so a convenience copy is never mistaken for the authoritative one.


```bash
assay plugin add assay.intent
assay intent capture --text "Exports must match what the table shows." --source "kickoff call"
assay intent promote 20260726-0a1b2c3d4e5f --to requirement --title "Full-fidelity export"
assay intent list --system billing --include-lineage
```

Assay stores captured text as given. Redact credentials and personal data before capturing; see [Agent Instructions](agent-instructions.md).

## Capability modules

```bash
assay capability add <module> [--root <dir>]
assay capability list [--root <dir>] [--json]
```

`capability list` shows every module with how the workspace obtained it: `archetype` for modules the archetype provides, `added` for modules enabled afterwards.

The current supported module is `intent`. Unknown module names fail closed.

Templates a capability scaffolds are managed files like any other, so `assay update` reconciles them and `assay check` reports the module's directories as required structure.

## Custom archetypes


Template entries can carry their own content, so an archetype pack does not depend on built-in templateIds:

```yaml
templates:
  # Reuse a built-in content generator by templateId.
  - { path: "work/README.md", templateId: "custom.work.readme", content: "# Work\n" }
  # Inline content; {{project}} is substituted with the project name.
  - path: "inbox/README.md"
    templateId: "custom.inbox.readme"
    content: "# {{project}} inbox\n"
  # Content file resolved relative to the directory containing this YAML.
  - path: "sources/README.md"
    templateId: "custom.sources.readme"
    file: "my-archetype/sources-readme.md"
```

`content` and `file` are mutually exclusive per entry. `file` paths must stay inside the archetype directory. A templateId that resolves to no content (no built-in generator and no carried content) is an error rather than a silent skip. Template entries are merged by path with `extends: base`, so an archetype can override base templates such as the root `README.md`.

## Adopt an existing project

Use `adopt` when an ordinary project already occupies the directory where you want a standalone Assay workspace and you want to archive the existing content first. Always inspect the plan first:

```bash
cd /path/to/existing-project
assay adopt --dry-run
assay adopt --apply --name ExistingProject --analyze --no-track [--no-agents]
```

`--apply` moves direct root entries into `.old/<timestamp>/`, keeps `.git/` at the root, and initializes the Assay scaffold. `--analyze` also creates an adoption inventory analysis so you can decide where archived content belongs. Move files out of `.old/` after review; `assay check --advisories` reports archived content that remains there.
