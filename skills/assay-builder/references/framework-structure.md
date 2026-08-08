# Framework directory structure

Every current Assay workspace has a shared base, then the selected archetype adds its own working directories:

```text
<project-root>/
├── .assay/       # version, manifest, plugin receipts, registries, events, migrations, backups
├── tasks/             # native bounded outcomes; overlay uses .assay/tasks/
├── systems/          # registered systems and local implementations
│   ├── <name>/             # active system (system.yaml + source; may be independent git repo)
│   └── archive/            # archived prior systems, copy-first move
├── knowledge/        # accepted reusable knowledge only
│   ├── patterns/     # validated reusable patterns
│   ├── guides/       # operational guides
│   └── troubleshooting/  # failure modes and fixes
├── references/       # native external evidence; eager in study, lazy elsewhere
├── analyses/         # native analyses; eager in study, lazy elsewhere
├── problem/          # solve/absorption-mode source materials, when enabled
├── project/           # required native Project envelope, charter, and Roadmap items
└── approaches/       # explore alternatives, when enabled
```

## Project archetype and mode

A workspace records `project.archetype` and `project.mode` in `.assay/manifest.json`. `assay init --archetype <archetype>` selects the archetype; the archetype YAML sets the mode. Use `assay archetype` to read the active values from the manifest.

Custom archetypes are YAML files resolved in order: project-local `.assay/archetypes/<name>.yaml`, user-global `~/.assay/archetypes/<name>.yaml`, then built-ins. Template entries may reuse built-in templateIds, carry inline `content` (with `{{project}}` substitution), or reference a `file` relative to the archetype directory — so third-party archetype packs can ship their own README/template content. Unresolvable template entries fail loudly at init/update time.

An archetype should also say what it is for and what each directory holds:

```yaml
description: Attack one goal that has a measurable success criterion, using bounded attempts until the score moves.

dirs:
  - path: problem
    purpose: Task statement, official rules, scoring definition
  - plain-directory-with-no-purpose
```

`assay status`, the `AGENTS.md` managed block, and the placement advisories in `assay check --advisories` all read those declarations, so a custom archetype explains itself everywhere without any change to Assay. Directories under `.assay/` and `<zone>/templates` folders are treated as machinery rather than places to put work and stay out of all three; declare the parent directory when you want it listed. After changing an archetype, run `assay update --agents` so the `AGENTS.md` table matches it again.

- **learning** (default): the project learns from external systems. Living external sources are added under `references/<alias>/` with `source.yaml`, current `checkout/`, bounded `materials/`, `history.md`, and a flat observation ledger (`observations/`, `manifests/`, `comparisons/`, `captures/`). Use this when the external thing is something you study, not something you are.
- **absorption**: the project exists to absorb a specific external thing (a benchmark target, a paper, a repo you are rebuilding). Its official/source materials land under `problem/<name>/` with a `source.yaml` case file, because they ARE the project, not external references. `references/frozen/` is still available for genuine third-party side evidence.

`source add` is the preferred learning-mode intake for external systems that may change. `absorb` still routes automatically based on mode for the freeze-and-open-analysis flow: legacy/full capture under `references/frozen/` in learning mode, `problem/` in absorption mode.

## Integrity checks and optional advisories

`assay check` validates workspace structure and persisted-record integrity. A
file existing does not prove content quality, so Assay does not turn prose
heuristics into mandatory gates. Use `assay check --advisories` when workflow
reminders are useful:

- A frozen reference directory with no `reference.yaml` is listed with the
  `assay reference backfill <path>` command that writes one. Provenance is
  checkable; whether someone read the material is not.
- A living source observation must always retain provenance, fingerprint, and
  manifest metadata. A `major` observation can additionally be listed as a
  revalidation advisory until a bound analysis closes.
- An analysis at `Status: draft` with empty `## Key observations` is listed as
  an unfinished-draft advisory.
- `analysis close --exit …` records the explicit decision and marks a bound
  source observation closed; it does not judge section prose.


## Intent-to-directory mapping

| User intent | Directory |
| --- | --- |
| study others' projects/materials | `references/` |
| analyze them | `analyses/` |
| absorb objective inputs | `problem/`, `intake/` |
| explore local approaches | `approaches/`, `trials/`, `comparison.md` |
| build local systems | `systems/` |
| keep one bounded outcome identifiable across contexts | `tasks/` |
| promote accepted findings | `knowledge/` |
| record the adopted charter, roadmap, specifications, and selected extensions | `project/` |

`project/` is required and follows the work root: standalone uses `project/`, overlay uses `.assay/project/`. Init creates `project.yaml`, `README.md`, and explanatory `roadmap/README.md`; native Roadmap records are added under `roadmap/<id>/`. Native Specifications are lazy under `specs/<id>/{spec.yaml,specification.md}` and promotion never changes its Analysis or Task source. Project-selected Relay records and extensions are also lazy; Reference, Analysis, Task, System, and runtime state keep separate authority.

Native Task follows the same work root: `tasks/` in standalone and
`.assay/tasks/` in overlay. Each stable-id directory requires a machine
`task.json` envelope and a reader-editable `prd.md` contract. `handoff.md`,
`design.md`, and `research/` are optional. `.assay/task-contexts.json` stores
exact host-context bindings. Task does not own roadmaps, specifications,
acceptance, permissions, dispatch, agent ownership, or Relay promotion.

## `.assay/` managed files

The CLI writes and maintains these files automatically:

- `.assay/VERSION` — installed framework template version.
- `.assay/manifest.json` — managed file manifest with template IDs, hashes, desired plugins, and exclusive provider bindings.
- `.assay/plugins.json` — installed plugin receipts.
- `.assay/task-contexts.json` — exact host-context bindings for native Tasks; the CLI owns this file.
- `.assay/trellis/` — legacy operational task/session/journal/config/channel/worker state, WAL, terminal archive, and migration receipts. Native Tasks do not automatically import or migrate it. Codex sessions remain external and read-only.
- `.assay/systems-registry.json` — system registry: primary marker, status, vcs, supersedes chain.
- `.assay/events/YYYY-MM.jsonl` — auditable JSONL event ledger.
- `.assay/backups/` — pre-update and pre-migration backups.
- `.assay/migrations/` — migration records.


`.trellis/` is not an Assay-managed path and is not used by the legacy
`assay.trellis` plugin. Its operational task/session/journal/config/channel/worker state lives under
`.assay/trellis/`; hook registration calls the installed Assay command directly
and does not copy a project hook script.

## `systems/` and version control

`systems/` may contain a mix of:

- **Independent git repositories** — declared as `vcs: independent-git` in the registry. The root repo `.gitignore` typically excludes the system path but allows `system.yaml`. Framework `check` skips system internals and validates only the contract file.
- **Embedded systems** — declared as `vcs: embedded`. System source is tracked by the root repo.

Each registered system has a `systems/<name>/system.yaml` contract file recording project, name, version, status, vcs, and supersedes. The contract is the only system-side file the framework receives; `README.md`, `CHANGELOG.md`, and `docs/*` belong to the system itself, not the framework.

Read `systems-registry.md` for registry schema, status state machine, and migration notes for legacy layouts.
