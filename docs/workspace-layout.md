# Workspace Layout

Assay has two layout modes. Both use `.assay/` as the Assay-owned state directory. Legacy `.framework/` workspaces are accepted for migration and discovery only; run `assay migrate-layout --apply` to move them to `.assay/`.

## Standalone mode

Use standalone when the Assay workbench is the project: research, evaluation, solve, science, or cross-system learning.

```text
.assay/     manifest, version, events, migrations, backups, registries, archetypes
systems/    registered systems and system metadata
knowledge/  accepted reusable decisions, patterns, guides, and troubleshooting notes
```

Archetype-specific working directories sit alongside this base.

| Archetype | Adds |
| --- | --- |
| `library` | No extra structure; it is the public entrypoint for the base. |
| `study` | `references/`, `references/frozen/`, `analyses/references/`, `analyses/gaps/`, `analyses/patterns/`, `analyses/templates/`, and `knowledge/decisions/`. |
| `solve` | `problem/`, `intake/`, `benchmarks/`, `attempts/`, `tools/`, `iterations/templates/`, `objective.json`, `systems/current.json`, and `runs.jsonl`. |
| `science` | `hypotheses/`, `experiments/`, `datasets/`, `findings/`, `papers/`, and `iterations/templates/`. |
| `evaluation` | `candidates/`, `criteria.md`, `scorecards/`, and `knowledge/decisions/`. |
| `explore` | `approaches/`, `trials/`, `comparison.md`, and `iterations/templates/`. |

Each living source stores its observation ledger flat under `references/<alias>/` as `observations/`, `manifests/`, `comparisons/`, and `captures/`. Older v3 workspaces nested these under `references/<alias>/.assay/`. That nesting is read as a compatibility fallback and is never rewritten: existing v3 entries keep working in place, while every new observation is written to the flat layout.

## Donor state

Donor adoption records live under the Assay state directory in both layout modes:

```text
.assay/donors/<adoption-id>/
  definitions/<digest>.json
  inspections/<inspection-id>.json
  evidence/<evidence-id>.json
  decisions/<decision-id>.json
  state.json
```

No archetype scaffolds `.assay/donors/`. The storage layer creates the directory and each adoption folder on demand, the first time `assay donor register` runs, so a workspace that never records a donor relationship has no donor directory at all. `assay check` validates these records only when they exist.

Definitions, inspections, evidence, and decisions are immutable content-addressed files; `state.json` is the current pointer (active definition, per-target baselines, committed decisions, generation). Use `assay donor` commands rather than editing them by hand. For the record semantics see [Donor Adoption](donor-adoption.md).

## Overlay mode

Use overlay when an existing product repo root should be the primary system. Assay writes one `.assay/` directory and keeps product files in place:

```text
.assay/
  manifest.json
  systems-registry.json
  events/
  backups/
  systems/root.yaml
  references/
  analyses/
  iterations/
  knowledge/
```

Overlay does not create root-level `references/`, `analyses/`, `iterations/`, `knowledge/`, or `systems/` folders. It does not modify tracked root files by default.

## Runtime paths

Commands resolve paths through the manifest `layout` block. Do not hard-code `references/` or `analyses/` at root. In standalone, those paths resolve to root-level folders. In overlay, they resolve under `.assay/`.

## Git expectations

Standalone Git is optional and belongs to the Assay workbench. Overlay Git belongs to the product repo and should ignore `.assay/` by default. `assay attach --privacy private` writes `/.assay/` to `.git/info/exclude` so product commits stay clean. If Assay state needs history in overlay without entering product Git, initialize a separate Git repository inside `.assay/` with `--privacy private-git`.

## Conversion

Overlay can be detached into standalone by creating a sibling workbench, hoisting `.assay/references` to `references`, `.assay/analyses` to `analyses`, and registering the original product repo as an external independent primary system. Use `assay convert --to standalone --target <sibling>`. Avoid in-place conversion unless explicitly requested with a destructive flag.
