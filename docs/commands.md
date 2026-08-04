# Commands

Run workspace commands from inside an Assay workspace. Commands discover the workspace by looking for `.assay/manifest.json`; legacy `.framework/manifest.json` is a migration fallback only. Pass `--root <dir>` to operate on another workspace.

## Workspace lifecycle

```bash
assay init [target-dir] --name <project> --archetype <name> [--plugin <id...>] [--git] [--force] [--create-new] [--no-track] [--no-agents]
assay attach [--root <dir>] --name <project> --archetype <name> [--plugin <id...>] [--privacy private|private-git|tracked] [--no-track] [--no-agents]
assay convert --to standalone --target <dir> [--move | --copy] [--no-keep-overlay]
assay check [--advisories] [--root <dir>]
assay status [--root <dir>] [--json] [--fetch]
assay update [--root <dir>] [--dry-run] [--agents] [--force | --skip-all | --create-new] [--no-track]
assay migrate-layout [--root <dir>] [--dry-run | --apply] [--backup]
assay archetype [--root <dir>] [--json]
assay archetype list [--root <dir>] [--json]
```

`init` creates a standalone workspace: Assay state in `.assay/`, work folders at the root. `attach` creates an overlay inside an existing product repository: everything Assay-owned lives under `.assay/`, product files stay where they are, and product Git ignores `.assay/` by default. `convert --to standalone` detaches an overlay into a sibling standalone workbench without moving the product repo.

`--plugin assay.intent` installs the intent module after a successful `init` or
`attach`. `--plugin assay.trellis` installs the built-in workspace runtime under
`.assay/trellis/`; it has no external sidecar preflight. Both remain options on
the existing lifecycle verbs, not a third setup operation.

`init`, successful `update`, and successful `adopt --apply` write a user-local project registry under `~/.assay/projects` by default. Use `--no-track` on those commands, or set `ASSAY_NO_TRACK=1`, to skip registry writes. The `assay projects` commands manage registry metadata only; they never delete workspace files.

`init` and successful `adopt --apply` also add a short Assay-managed block to root `AGENTS.md` by default. Use `--no-agents` on those commands to skip it. Ordinary `assay update` refreshes the block only when it already exists; `assay update --agents` creates or re-enables it.

If `AGENTS.md` contains incomplete `<!-- ASSAY:START -->` / `<!-- ASSAY:END -->` markers, Assay leaves the file unchanged and reports the malformed block so you can fix or remove it manually.

`assay check` validates required structure, registries, indexes, managed-file
state, source observation integrity, and donor persistence. It exits non-zero
only for missing required structure or invalid persisted state. Add
`--advisories` to request non-blocking workflow reminders such as open
iterations, unfinished draft analyses, pending queue entries, lingering
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

`status` also prints a `Decision records` line for a source whose latest change
was graded `major` or `replacement`. The built-in Trellis runtime does not
replace native decision governance, so the next action continues to name the
Assay ADR workflow. Nothing is blocked.

## Workspace plugins and reconcile

```bash
assay plugin add <id> [--root <dir>]
assay plugin list [--root <dir>] [--json]
assay plugin check [--root <dir>] [--json]
assay reconcile [--root <dir>] [--plugin <id...>] [--dry-run | --apply] [--json]
```

`assay.intent` (alias: `intent`) contributes the additive `intent` capability.
`plugin add` declares it in `.assay/manifest.json`, creates only missing intent
scaffold files, and writes an installation receipt to `.assay/plugins.json`.
Existing files are never overwritten.

`assay.trellis` (alias: `trellis`) is a built-in `workspace-runtime` plugin.
Its protocol version, per-plugin receipt `state_version`, and dedicated runtime
state schema are all exactly `1`. Dynamic task state is stored only in
`.assay/trellis/`; no Trellis CLI or root `.trellis/` sidecar is used. It
declares task-store, context-provider, and host-hook-registration runtime
capabilities while Assay native ADR and intent remain active.

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
built-in `assay.trellis` runtime does not claim `decision-governance`;
`assay.native` continues to own ADRs. Reconcile migrates the 0.5 preview's
legacy `federated-provider` declaration/receipt and removes its obsolete
`decision-governance` binding without reading or modifying `.trellis/`.

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

The new workbench hoists `.assay/references` to `references`, `.assay/analyses` to `analyses`, `.assay/project-authority` to `project-authority`, and so on. Assay state travels with it: manifest, systems registry, ADR index (with ADR paths rewritten to the new layout), events, backups, donor records, project-local archetypes, and `.assay/trellis` runtime state. Project Authority files are copied or moved byte-for-byte; conversion refuses a non-empty target `project-authority/` before writing any target state instead of merging or overwriting it. The original product repo is registered as the primary independent system by relative path (`../existing-repo`). Use `--move` to move instead of copy. `--no-keep-overlay` removes the emptied `.assay/` from the source and requires `--move`; with a copy the overlay is still the only holder of that state. The product repo and its `.git/` are never modified.

`assay update` follows the workspace layout. In an overlay workspace, managed templates are written under `.assay/`, and root `README.md`, `.gitignore`, and `AGENTS.md` are never created or replaced — including with `--force`.

## Sources, analyses, and iterations

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
assay analysis close <path> --exit adopt|reject|experiment|adr [--note <note>] [--root <dir>]
assay iteration start <title> [--root <dir>]
assay iteration close <selector> --result applied|rejected|retest [--note <note>] [--root <dir>]
assay event capture --kind observation|analysis|decision|gotcha|note --text <text> [--root <dir>]
assay knowledge add <type> <title> [--from-analysis <path>] [--from-iteration <path>] [--root <dir>]
```

Each living source stores its observation ledger flat under `references/<alias>/` as `observations/`, `manifests/`, `comparisons/`, and `captures/`. Older v3 workspaces nested these under `references/<alias>/.assay/`. That nesting is read as a compatibility fallback and is never rewritten: existing v3 entries keep working in place, while every new observation is written to the flat layout.

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

## Systems, ADRs, and project registry

```bash
assay system register <path> [--root <dir>] [--name <name>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--primary] [--supersedes <names>] [--intent-authority inline|external|none] [--intent-pointer <pointer>]
assay system update <selector> [--root <dir>] [--path <path>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--contract-file <path> | --no-contract-file] [--primary] [--supersedes <names>] [--intent-authority inline|external|none | --no-intent-authority] [--intent-pointer <pointer>]
assay system promote <selector> [--root <dir>]
assay system archive <selector> [--root <dir>] [--dry-run | --apply]
assay system list [--root <dir>] [--status primary|active|superseded|archived] [--json]
assay system show <selector> [--root <dir>] [--json]
assay adr new <title> [--from-analysis <path>] [--from-iteration <path>] [--force] [--root <dir>]
assay adr accept <selector> [--root <dir>]
assay adr supersede <old-selector> <new-selector> [--root <dir>]
assay adr deprecate <selector> [--root <dir>]
assay adr list [--root <dir>] [--status proposed|accepted|superseded|deprecated] [--native] [--json]
assay adr show <selector> [--root <dir>] [--native] [--json]
assay projects
assay projects list [--json] [--all] [--status active|missing|uninstalled]
assay projects scan <roots...> [--json]
assay projects show <selector> [--json]
assay projects forget <selector>
assay projects prune [--dry-run] [--json]
```

Use `system register` only for first-time registration; it rejects duplicate names so accidental re-registration is visible. Use `system update <selector>` to correct metadata on an existing record, such as changing `vcs` from `embedded` to `independent-git` and setting `--vcs-ref main`. Omitted update fields are preserved. `--primary` uses the same one-primary behavior as `system promote`, and archived systems are read-only.

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

`.trellis/`, `.superpowers/`, or an existing `docs/adr/` directory can produce
the legacy parallel-governance advisory, but native ADR creation remains
available. Installing `assay.trellis` does not bind or replace decision
governance: `adr new|accept|supersede|deprecate`,
`intent promote --to decision`, and `knowledge add decision` continue through
the Assay-native ADR workflow. `adr list --native` and `adr show --native`
remain explicit aliases for reading that same native archive.

## Product intent

Intent records what was actually asked for, kept separate from what was later built. It is an optional capability module; enable it with `assay plugin add assay.intent`. The older `assay capability add intent` path remains compatible.

```bash
assay intent capture [--text <text> | --file <workspace-relative-path>] [--system <name>] [--source <text>] [--supersedes <ids>] [--force] [--root <dir>]
assay intent promote <capture> --to requirement|decision [--title <title>] [--root <dir>]
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

`promote --to requirement` writes `intent/requirements/<date>-<slug>.md` carrying `derives_from`. `promote --to decision` creates an ADR through the `adr` capability with `related_intent` and `system` set, so the decision points back at the words it answers.

```bash
assay plugin add assay.intent
assay intent capture --text "Exports must match what the table shows." --source "kickoff call"
assay intent promote 20260726-0a1b2c3d4e5f --to requirement --title "Full-fidelity export"
assay intent list --system billing --include-lineage
```

Assay stores captured text as given. Redact credentials and personal data before capturing; see [Agent Instructions](agent-instructions.md).

## Capability modules

Capability modules are optional workspace features: `adr` enables the ADR commands and index, `intent` enables the intent commands and directories, `iteration` enables the iteration commands and templates, and `project-authority` creates the project-owned home for facts, Policy, Norms, Specs, and Relay records. An archetype turns some of them on at init, and `capability add` turns the rest on later, so the archetype chosen at init does not lock the workspace out of a capability it needs afterwards.

```bash
assay capability add <module> [--root <dir>]
assay capability list [--root <dir>] [--json]
```

`capability add` creates the module's directories and templates through the workspace layout — under `.assay/` in an overlay workspace, at the root in a standalone one — writes any state file the module needs (`adr` creates `.assay/adrs.json`), records the module in the manifest, and appends a `capability.added` event. Files that already exist are left alone, and a module the workspace already has reports that and changes nothing, so the command is safe to re-run.

```bash
assay capability add adr        # an explore workspace gains knowledge/decisions/ and adr commands
assay adr new "Adopt overlay layout"
assay capability add project-authority
```

`capability list` shows every module with how the workspace obtained it: `archetype` for modules the archetype provides, `added` for modules enabled afterwards.

Templates a capability scaffolds are managed files like any other, so `assay update` reconciles them and `assay check` reports the module's directories as required structure.

Project Authority is a project-owned area, not a fourth product or an operational plugin. It resolves through the existing work root: `project-authority/` in standalone and `.assay/project-authority/` in every overlay privacy mode. The project owns its facts and constraints and owns and selects activation, fork, and promotion records; Relay interprets Relay documents and schemas. Assay only scaffolds and protects the location, checks structure and managed-file integrity, and carries the directory through conversion. It does not create `relay/activation.json`, parse Relay schemas, decide facts or constraints, grant permission, or accept results. Acceptance requirements belong in the governing Policy or named-object Spec rather than a separate directory.

## Custom archetypes

Archetype lookup order is project-local `.assay/archetypes/<name>.yaml`, then user-global `~/.assay/archetypes/<name>.yaml`, then built-ins. A custom archetype YAML declares `extends: base`, `mode`, `modules` (`adr`, `intent`, `iteration`, `project-authority`), `dirs`, and `templates`.

Template entries can carry their own content, so an archetype pack does not depend on built-in templateIds:

```yaml
templates:
  # Reuse a built-in content generator by templateId.
  - { path: "iterations/README.md", templateId: "iterations.readme" }
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
