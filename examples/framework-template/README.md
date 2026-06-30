
# Assay

A versioned external-system-learning framework.

Core loop:

```text
references → analyses → systems → iterations → knowledge
```

| Path | Purpose |
| --- | --- |
| `.framework/` | Runtime metadata: version, manifest, events, migrations, backups |
| `references/` | External systems and frozen snapshots |
| `analyses/` | Analysis layer that turns external systems into decisions |
| `systems/` | Our active framework implementation; `assay-core/` is the current core |
| `iterations/` | Iterations against our own framework |
| `knowledge/` | Accepted reusable knowledge |
| `data/` | Research samples and evaluation data |
| `releases/` | Release notes and upgrade packages |

## First workflow

1. Freeze one external project under `references/frozen/YYYYMM/<name>/`.
2. Write a reference analysis in `analyses/references/`.
3. Convert a promising mechanism to `analyses/patterns/`.
4. Start an iteration in `iterations/YYYY-MM-DD-<topic>/`.
5. Land the validated change in `systems/assay-core/`.
6. Promote durable learning to `knowledge/`.
