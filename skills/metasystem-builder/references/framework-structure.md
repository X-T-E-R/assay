# Framework directory structure

Every MetaSystem workspace converges to this layout (layout v3):

```text
<project-root>/
├── .framework/       # version, manifest, registries, events, migrations, backups
├── references/       # external systems; intake + frozen snapshots
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
