# Commands

Run workspace commands from inside an Assay workspace. Commands discover the workspace by looking for `.assay/manifest.json`; legacy `.framework/manifest.json` is a migration fallback only. Pass `--root <dir>` to operate on another workspace.

## Workspace lifecycle

```bash
assay init [target-dir] --name <project> --archetype <name> [--git] [--force] [--create-new] [--no-track] [--no-agents]
assay attach [--root <dir>] --name <project> --archetype <name> [--privacy private|private-git|tracked] [--no-track] [--no-agents]
assay convert --to standalone --target <dir> [--move | --copy] [--no-keep-overlay]
assay check [--advisories] [--root <dir>]
assay status [--root <dir>] [--json]
assay update [--root <dir>] [--dry-run] [--agents] [--force | --skip-all | --create-new] [--no-track]
assay migrate-layout [--root <dir>] [--dry-run | --apply] [--backup]
assay archetype [--root <dir>] [--json]
assay archetype list [--root <dir>] [--json]
```

`init` creates a standalone workspace: Assay state in `.assay/`, work folders at the root. `attach` creates an overlay inside an existing product repository: everything Assay-owned lives under `.assay/`, product files stay where they are, and product Git ignores `.assay/` by default. `convert --to standalone` detaches an overlay into a sibling standalone workbench without moving the product repo.

`init`, successful `update`, and successful `adopt --apply` write a user-local project registry under `~/.assay/projects` by default. Use `--no-track` on those commands, or set `ASSAY_NO_TRACK=1`, to skip registry writes. The `assay projects` commands manage registry metadata only; they never delete workspace files.

`init` and successful `adopt --apply` also add a short Assay-managed block to root `AGENTS.md` by default. Use `--no-agents` on those commands to skip it. Ordinary `assay update` refreshes the block only when it already exists; `assay update --agents` creates or re-enables it.

If `AGENTS.md` contains incomplete `<!-- ASSAY:START -->` / `<!-- ASSAY:END -->` markers, Assay leaves the file unchanged and reports the malformed block so you can fix or remove it manually.

`assay check` validates required structure, registries, indexes, managed-file
state, source observation integrity, and donor persistence. It exits non-zero
only for missing required structure or invalid persisted state. Add
`--advisories` to request non-blocking workflow reminders such as open
iterations, unfinished draft analyses, pending queue entries, lingering
adoption archives, unanalyzed frozen references, and major source changes that
have not been re-reviewed.

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

The new workbench hoists `.assay/references` to `references`, `.assay/analyses` to `analyses`, and so on. Assay state travels with it: manifest, systems registry, ADR index (with ADR paths rewritten to the new layout), events, backups, donor records, and project-local archetypes. The original product repo is registered as the primary independent system by relative path (`../existing-repo`). Use `--move` to move instead of copy. `--no-keep-overlay` removes the emptied `.assay/` from the source and requires `--move`; with a copy the overlay is still the only holder of that state. The product repo and its `.git/` are never modified.

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
assay analysis new <title> [--root <dir>] [--for-source <alias>] [--observation <id-or-path>] [--for-reference <path>]
assay analysis close <path> --exit adopt|reject|experiment|adr [--note <note>] [--root <dir>]
assay iteration start <title> [--root <dir>]
assay iteration close <selector> --result applied|rejected|retest [--note <note>] [--root <dir>]
assay event capture --kind observation|analysis|decision|gotcha|note --text <text> [--root <dir>]
assay knowledge add <type> <title> [--from-analysis <path>] [--from-iteration <path>] [--root <dir>]
```

Each living source stores its observation ledger flat under `references/<alias>/` as `observations/`, `manifests/`, `comparisons/`, and `captures/`. Older v3 workspaces nested these under `references/<alias>/.assay/`. That nesting is read as a compatibility fallback and is never rewritten: existing v3 entries keep working in place, while every new observation is written to the flat layout.

`analysis close` records the caller's explicit exit, updates bound reference or
source metadata, and writes an event. It does not block on section-content
heuristics. Use `assay check --advisories` before closing when unfinished-draft
reminders are useful.

## Donor adoption

Use donor commands when selected material from a living source has been
implemented, adapted, or otherwise carried into a registered target system:

```bash
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

`inspect` captures source and target direct-change facts. It is optional:
`decide` without `--inspection` captures the current snapshots inside the
decision operation. Evidence is advisory by default and blocks `accept` only
when the definition explicitly marks it `required`.

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
assay adr list [--root <dir>] [--status proposed|accepted|superseded|deprecated] [--json]
assay adr show <selector> [--root <dir>] [--json]
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
sidecar contract mirrors the field when it is generated at registration.
`system update --no-intent-authority` clears the field back to the default.

The built-in archetypes are `library`, `study`, `solve`, `science`, `evaluation`, and `explore`. Use `assay archetype list` to see built-ins plus custom YAML archetypes from the current project and `~/.assay/archetypes`.

When `.trellis/`, `.superpowers/`, or an existing `docs/adr/` directory is
present, `adr new` reports an advisory about parallel decision records and
still creates the requested Assay ADR. The legacy `--force` option only
suppresses that advisory; it is not required for creation.

## Product intent

Intent records what was actually asked for, kept separate from what was later built. It is an optional capability module; enable it with `assay capability add intent`.

```bash
assay intent capture [--text <text> | --file <workspace-relative-path>] [--system <name>] [--source <text>] [--supersedes <ids>] [--force] [--root <dir>]
assay intent promote <capture> --to requirement|decision [--title <title>] [--root <dir>]
assay intent list [--system <name>] [--include-lineage] [--json] [--root <dir>]
```

`capture` writes `intent/original/<YYYYMMDD>-<sha256:12>.md` holding the text verbatim, plus the resolved system name, the full SHA-256 of the body, and the capture time. `--file` is resolved relative to the workspace root and refuses to leave it; pass text from elsewhere with `--text`.

Captures are append-only:

- Capturing identical text again is a no-op and writes no second record.
- Capturing text whose record was edited after it was written fails, naming the recorded and current digests. Restore the file, or record the corrected wording as a new capture with `--supersedes <capture-id>`.

Every capture is scoped to one registered system. `--system` accepts a name or unique prefix and defaults to the current primary; the resolved name is written into the record, so a capture keeps naming the system it was about after `system promote` moves the primary pointer. `intent list --system <name> --include-lineage` follows the registry `supersedes` chain so captures made against a replaced system stay visible.

If the named system records `intent_authority: external` or `none`, `capture` refuses and prints the pointer. `--force` records the text anyway, marked `shadow: true` in the record and flagged in `intent list`, so a convenience copy is never mistaken for the authoritative one.

`promote --to requirement` writes `intent/requirements/<date>-<slug>.md` carrying `derives_from`. `promote --to decision` creates an ADR through the `adr` capability with `related_intent` and `system` set, so the decision points back at the words it answers.

```bash
assay capability add intent
assay intent capture --text "Exports must match what the table shows." --source "kickoff call"
assay intent promote 20260726-0a1b2c3d4e5f --to requirement --title "Full-fidelity export"
assay intent list --system billing --include-lineage
```

Assay stores captured text as given. Redact credentials and personal data before capturing; see [Agent Instructions](agent-instructions.md).

## Capability modules

Capability modules are optional workspace features: `adr` enables the ADR commands and index, `intent` enables the intent commands and directories, `iteration` enables the iteration commands and templates. An archetype turns some of them on at init, and `capability add` turns the rest on later, so the archetype chosen at init does not lock the workspace out of a capability it needs afterwards.

```bash
assay capability add <module> [--root <dir>]
assay capability list [--root <dir>] [--json]
```

`capability add` creates the module's directories and templates through the workspace layout — under `.assay/` in an overlay workspace, at the root in a standalone one — writes any state file the module needs (`adr` creates `.assay/adrs.json`), records the module in the manifest, and appends a `capability.added` event. Files that already exist are left alone, and a module the workspace already has reports that and changes nothing, so the command is safe to re-run.

```bash
assay capability add adr        # a library workspace gains knowledge/decisions/ and adr commands
assay adr new "Adopt overlay layout"
```

`capability list` shows every module with how the workspace obtained it: `archetype` for modules the archetype provides, `added` for modules enabled afterwards.

Templates a capability scaffolds are managed files like any other, so `assay update` reconciles them and `assay check` reports the module's directories as required structure.

## Custom archetypes

Archetype lookup order is project-local `.assay/archetypes/<name>.yaml`, then user-global `~/.assay/archetypes/<name>.yaml`, then built-ins. A custom archetype YAML declares `extends: base`, `mode`, `modules` (`adr`, `intent`, `iteration`), `dirs`, and `templates`.

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
