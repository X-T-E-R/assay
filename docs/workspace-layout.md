# Workspace Layout

Assay workspaces share a small base and then add directories from the selected archetype. Do not expect every workspace to contain every path; `assay check` reads the manifest and validates the structure for that workspace.

## Base Layout

Every built-in archetype extends the internal base:

```text
.framework/   manifest, version, events, migrations, backups, and registries
systems/      your own systems and registered system metadata
knowledge/    reusable decisions, patterns, guides, and troubleshooting notes
```

The base also manages the root README, root `.gitignore`, `.framework/README.md`, `systems/README.md`, and `knowledge/README.md`.

## Archetype Additions

| Archetype | Adds |
| --- | --- |
| `library` | No extra structure; it is the public entrypoint for the base. |
| `study` | `references/frozen/`, `analyses/references/`, `analyses/gaps/`, `analyses/patterns/`, `analyses/templates/`, and `knowledge/decisions/`. |
| `solve` | `problem/`, `intake/`, `benchmarks/`, `attempts/`, `tools/`, `iterations/templates/`, `objective.json`, `systems/current.json`, and `runs.jsonl`. |
| `science` | `hypotheses/`, `experiments/`, `datasets/`, `findings/`, `papers/`, and `iterations/templates/`. |
| `evaluation` | `candidates/`, `criteria.md`, `scorecards/`, and `knowledge/decisions/`. |
| `explore` | `approaches/`, `trials/`, `comparison.md`, and `iterations/templates/`. |

Commands can create additional runtime paths. For example, `source add` creates `references/<alias>/` with `source.yaml`, `checkout/`, `materials/`, `history.md`, and an internal observation ledger. `adopt --apply` creates `.old/<timestamp>/` until archived content is reviewed and moved.

## Custom Archetypes

Custom archetypes are YAML structures. Put project-local definitions in `.framework/archetypes/<name>.yaml` or user-global definitions in `~/.assay/archetypes/<name>.yaml`.

An archetype YAML can set:

- `extends: base` for the shared base structure;
- `mode: learning` or `mode: absorption`;
- `modules`, currently `adr` and `iteration`;
- `dirs`, `dirs_learning`, `dirs_absorption`, and `templates`.

Copy a built-in YAML when creating a new archetype. That keeps the command surface the same while changing the workspace structure and conventions.
