
# Assay

A versioned external-system-learning framework.

Core loop:

```text
references → analyses → systems → iterations → knowledge
```

| Path | Purpose |
| --- | --- |
| `.framework/` | Runtime metadata: version, manifest, events, migrations, backups |
| `references/` | Living external sources, selected materials, and legacy full captures |
| `analyses/` | Analysis layer that turns external systems into decisions |
| `systems/` | Our active framework implementation; `assay-core/` is the current core |
| `iterations/` | Iterations against our own framework |
| `knowledge/` | Accepted reusable knowledge |
| `data/` | Research samples and evaluation data |
| `releases/` | Release notes and upgrade packages |

## First workflow

1. Add one external project with `assay source add <repo-or-dir> [alias]`.
2. Inspect `references/<alias>/checkout/`, `materials/`, `source.yaml`, and `history.md`.
3. Write a reference or delta analysis in `analyses/references/`.
4. Convert a promising mechanism to `analyses/patterns/`.
5. Start an iteration in `iterations/YYYY-MM-DD-<topic>/`.
6. Land the validated change in `systems/assay-core/`.
7. Promote durable learning to `knowledge/`.
