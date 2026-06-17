# Framework directory structure

Every MetaSystem workspace converges to this layout:

```text
<project-root>/
├── .framework/       # version, manifest, events, migrations, backups
├── references/       # external systems; intake + frozen snapshots
├── analyses/         # reference analysis, gap analysis, candidate patterns
├── systems/          # our active framework/system implementation
├── iterations/       # iterations on our own framework
├── knowledge/        # accepted reusable knowledge only
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
- `.framework/events/YYYY-MM.jsonl` — auditable JSONL event ledger.
- `.framework/backups/` — pre-update and pre-migration backups.
- `.framework/migrations/` — migration records.

Do not edit these files manually; use the CLI for all manifest and event operations.
