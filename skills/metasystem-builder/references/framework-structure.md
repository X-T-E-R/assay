# Framework directory structure

Every MetaSystem workspace converges to this layout (layout v3):

```text
<project-root>/
├── .framework/       # version, manifest, registries, events, migrations, backups
├── references/       # external systems; intake + frozen snapshots (learning mode)
├── problem/          # project-level source materials (absorption mode only)
├── analyses/         # reference analysis, gap analysis, candidate patterns
├── systems/          # our active framework/system implementations
│   ├── <name>/             # active system (system.yaml + source; may be independent git repo)
│   └── archive/            # archived prior systems, copy-first move
├── iterations/       # iterations on our own framework
├── knowledge/        # accepted reusable knowledge only
│   ├── decisions/    # accepted decisions and ADRs
│   ├── patterns/     # validated reusable patterns
│   ├── guides/       # operational guides
│   └── troubleshooting/  # failure modes and fixes
├── data/             # samples, evaluation data, research data
└── releases/         # release notes, packages, migration guides
```

## Project modes

A workspace declares its mode in `.framework/config.yaml` (`mode: learning` or `mode: absorption`), set by `metasystem init --mode <mode>`.

- **learning** (default): the project learns from external systems. External sources are frozen under `references/frozen/YYYYMM/<name>/` with a `reference.yaml` case file and analyzed as references. Use this when the external thing is something you study, not something you are.
- **absorption**: the project exists to absorb a specific external thing (a contest, a paper, a repo you are rebuilding). Its official/source materials land under `problem/<name>/` with a `source.yaml` case file, because they ARE the project, not external references. `references/frozen/` is still available for genuine third-party side evidence.

`absorb` routes automatically based on mode: `references/frozen/` in learning mode, `problem/` in absorption mode.

## Content gates (not just directory exits)

Each step of `references → analyses → systems → iterations → knowledge` must produce content before it counts as complete — a file existing is not enough. `check` enforces:

- A frozen reference must be cited by an analysis or have `reference.yaml.analyzed: true`, else `unanalyzed reference` warning.
- An analysis at `Status: draft` must have non-empty `## Key observations`, else `empty analysis` warning.
- `analysis close --exit …` is what flips `reference.yaml.analyzed` to `true`, closing the loop.


## Intent-to-directory mapping

| User intent | Directory |
| --- | --- |
| store others' projects/materials | `references/` |
| analyze them | `analyses/` |
| build our own framework | `systems/` |
| iterate our own framework | `iterations/` |
| promote accepted findings | `knowledge/` |
| store evaluation/research data | `data/` |
| publish release notes and migration guides | `releases/` |

## `.framework/` managed files

The CLI writes and maintains these files automatically:

- `.framework/VERSION` — installed framework template version.
- `.framework/manifest.json` — managed file manifest with template IDs and SHA-256 hashes.
- `.framework/systems-registry.json` — system registry: primary marker, status, vcs, supersedes chain (layout v3+).
- `.framework/adrs.json` — ADR index: number allocator, status, supersedes chain, and file paths.
- `.framework/events/YYYY-MM.jsonl` — auditable JSONL event ledger.
- `.framework/backups/` — pre-update and pre-migration backups.
- `.framework/migrations/` — migration records.

Do not edit these files manually; use the CLI for all manifest, registry, ADR, and event operations.

## `systems/` and version control

`systems/` may contain a mix of:

- **Independent git repositories** — declared as `vcs: independent-git` in the registry. The root repo `.gitignore` typically excludes the system path but allows `system.yaml`. Framework `check` skips system internals and validates only the contract file.
- **Embedded systems** — declared as `vcs: embedded`. System source is tracked by the root repo.

Each registered system has a `systems/<name>/system.yaml` contract file recording project, name, version, status, vcs, and supersedes. The contract is the only system-side file the framework receives; `README.md`, `CHANGELOG.md`, and `docs/*` belong to the system itself, not the framework.

Read `systems-registry.md` for registry schema, status state machine, and migration from layout v2.
