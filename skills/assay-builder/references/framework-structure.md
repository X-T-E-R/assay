# Framework directory structure

Every current Assay workspace has a shared base, then the selected archetype adds its own working directories:

```text
<project-root>/
├── .assay/       # version, manifest, registries, events, migrations, backups
├── systems/          # registered systems and local implementations
│   ├── <name>/             # active system (system.yaml + source; may be independent git repo)
│   └── archive/            # archived prior systems, copy-first move
├── knowledge/        # accepted reusable knowledge only
│   ├── decisions/    # accepted decisions and ADRs
│   ├── patterns/     # validated reusable patterns
│   ├── guides/       # operational guides
│   └── troubleshooting/  # failure modes and fixes
├── references/       # study/evaluation learning-mode sources, when enabled
├── analyses/         # study analysis cards, when enabled
├── problem/          # solve/absorption-mode source materials, when enabled
├── iterations/       # solve/science/explore iteration plans, when enabled
├── candidates/       # evaluation candidates, when enabled
├── hypotheses/       # science claims, when enabled
└── approaches/       # explore alternatives, when enabled
```

## Project archetype and mode

A workspace records `project.archetype` and `project.mode` in `.assay/manifest.json`. `assay init --archetype <archetype>` selects the archetype; the archetype YAML sets the mode. Use `assay archetype` to read the active values from the manifest.

Custom archetypes are YAML files resolved in order: project-local `.assay/archetypes/<name>.yaml`, user-global `~/.assay/archetypes/<name>.yaml`, then built-ins. Template entries may reuse built-in templateIds, carry inline `content` (with `{{project}}` substitution), or reference a `file` relative to the archetype directory — so third-party archetype packs can ship their own README/template content. Unresolvable template entries fail loudly at init/update time.

- **learning** (default): the project learns from external systems. Living external sources are added under `references/<alias>/` with `source.yaml`, current `checkout/`, bounded `materials/`, `history.md`, and a flat observation ledger (`observations/`, `manifests/`, `comparisons/`, `captures/`). Use this when the external thing is something you study, not something you are.
- **absorption**: the project exists to absorb a specific external thing (a benchmark target, a paper, a repo you are rebuilding). Its official/source materials land under `problem/<name>/` with a `source.yaml` case file, because they ARE the project, not external references. `references/frozen/` is still available for genuine third-party side evidence.

`source add` is the preferred learning-mode intake for external systems that may change. `absorb` still routes automatically based on mode for the freeze-and-open-analysis flow: legacy/full capture under `references/frozen/` in learning mode, `problem/` in absorption mode.

## Integrity checks and optional advisories

`assay check` validates workspace structure and persisted-record integrity. A
file existing does not prove content quality, so Assay does not turn prose
heuristics into mandatory gates. Use `assay check --advisories` when workflow
reminders are useful:

- A frozen reference that is not cited by an analysis and is not marked
  `analyzed: true` is listed as an `unanalyzed reference` advisory.
- A living source observation must always retain provenance, fingerprint, and
  manifest metadata. A `major` observation can additionally be listed as a
  revalidation advisory until a bound analysis closes.
- An analysis at `Status: draft` with empty `## Key observations` is listed as
  an unfinished-draft advisory.
- `analysis close --exit …` records the explicit decision and flips a bound
  `reference.yaml` to `analyzed: true`; it does not judge section prose.


## Intent-to-directory mapping

| User intent | Directory |
| --- | --- |
| study others' projects/materials | `references/` |
| analyze them | `analyses/` |
| absorb objective inputs | `problem/`, `intake/` |
| compare external candidates | `candidates/`, `criteria.md`, `scorecards/` |
| run science work | `hypotheses/`, `experiments/`, `datasets/`, `findings/`, `papers/` |
| explore local approaches | `approaches/`, `trials/`, `comparison.md` |
| build local systems | `systems/` |
| iterate local systems | `iterations/` |
| promote accepted findings | `knowledge/` |

## `.assay/` managed files

The CLI writes and maintains these files automatically:

- `.assay/VERSION` — installed framework template version.
- `.assay/manifest.json` — managed file manifest with template IDs and SHA-256 hashes.
- `.assay/systems-registry.json` — system registry: primary marker, status, vcs, supersedes chain.
- `.assay/adrs.json` — ADR index: number allocator, status, supersedes chain, and file paths.
- `.assay/events/YYYY-MM.jsonl` — auditable JSONL event ledger.
- `.assay/backups/` — pre-update and pre-migration backups.
- `.assay/migrations/` — migration records.

Do not edit these files manually; use the CLI for all manifest, registry, ADR, and event operations.

## `systems/` and version control

`systems/` may contain a mix of:

- **Independent git repositories** — declared as `vcs: independent-git` in the registry. The root repo `.gitignore` typically excludes the system path but allows `system.yaml`. Framework `check` skips system internals and validates only the contract file.
- **Embedded systems** — declared as `vcs: embedded`. System source is tracked by the root repo.

Each registered system has a `systems/<name>/system.yaml` contract file recording project, name, version, status, vcs, and supersedes. The contract is the only system-side file the framework receives; `README.md`, `CHANGELOG.md`, and `docs/*` belong to the system itself, not the framework.

Read `systems-registry.md` for registry schema, status state machine, and migration notes for legacy layouts.
