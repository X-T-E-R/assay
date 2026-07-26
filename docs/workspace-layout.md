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
| `solve` | `problem/`, `intake/`, `benchmarks/`, `attempts/`, `tools/`, `iterations/`, `iterations/templates/`, `objective.json`, and `systems/current.json`. |
| `science` | `hypotheses/`, `experiments/`, `datasets/`, `findings/`, `papers/`, `iterations/`, and `iterations/templates/`. |
| `evaluation` | `candidates/`, `criteria.md`, `scorecards/`, and `knowledge/decisions/`. |
| `explore` | `approaches/`, `trials/`, `comparison.md`, `iterations/`, and `iterations/templates/`. |

## Directory purposes

An archetype states what each directory is for, next to the directory itself:

```yaml
description: Attack one goal that has a measurable success criterion, iterating until the score moves.

dirs:
  - path: problem
    purpose: Task statement, official rules, scoring definition
  - path: intake
    purpose: Raw deliveries that have not been normalized yet
```

A bare string entry (`- problem`) remains valid and declares no purpose.

Three surfaces read these declarations, so a custom archetype gets all three
without any code change:

- the Assay managed block in `AGENTS.md` renders them as a directory table, which puts the layout in context at the start of a session;
- `assay status` lists each directory with its file count and purpose, under a header naming the archetype and its `description`;
- `assay check --advisories` reports top-level directories the archetype never declared.

Directories are omitted from all three where they are not places to put work:
anything under `.assay/`, and `<zone>/templates` folders that hold blank forms
for their parent. An archetype that wants the parent listed declares the parent
itself, which is why `solve` declares both `iterations` and
`iterations/templates`.

Changing an archetype's directories or purposes leaves the `AGENTS.md` table
stale until `assay update --agents` regenerates it; `assay check --advisories`
reports that mismatch.

## Run records in solve workspaces

Assay does not create `runs.jsonl` and no command writes to it. Where a run log
is useful, an existing harness — an evaluator, a judge script, a packaging step
— appends one JSON object per line to `runs.jsonl` at the workspace root.
Suggested fields are `run_id`, `started_at`, `benchmark`, `attempt`, `score`,
`params`, `artifact`, and `notes`; nothing validates the shape. `assay status`
reports the record count once the file exists. The solve `README.md` carries
the same convention.

Each living source stores its observation ledger flat under `references/<alias>/` as `observations/`, `manifests/`, `comparisons/`, and `captures/`. Older v3 workspaces nested these under `references/<alias>/.assay/`. That nesting is read as a compatibility fallback and is never rewritten: existing v3 entries keep working in place, while every new observation is written to the flat layout.

## Capability module structure

Capability modules own a small, fixed part of the layout. An archetype that declares a module scaffolds it at init; `assay capability add <module>` scaffolds the same structure in a workspace that did not start with it and records the module under `project.capabilities` in the manifest.

| Module | Adds |
| --- | --- |
| `adr` | `knowledge/decisions/` with `README.md` and `ADR-TEMPLATE.md`, plus the `.assay/adrs.json` index. |
| `intent` | `intent/`, `intent/original/`, and `intent/requirements/`, each with a `README.md`. |
| `iteration` | `iterations/` and `iterations/templates/` with `README.md` and `iteration-plan.md`. |

These paths resolve through the workspace layout like every other work folder: `knowledge/decisions/` in standalone, `.assay/knowledge/decisions/` in overlay. Run `assay capability list` to see which modules a workspace has and how it got them.

## Intent records

The intent module keeps two kinds of file, both plain Markdown with YAML frontmatter:

```text
intent/original/<YYYYMMDD>-<sha256:12>.md    verbatim capture; frontmatter carries
                                             system, sha256, captured_at, and
                                             optionally source, supersedes, shadow
intent/requirements/<date>-<slug>.md         requirement carrying derives_from
```

The capture filename is derived from the SHA-256 of its own body, and the full digest is recorded in the frontmatter. That is what makes captures append-only: a re-capture of the same text lands on the same path and changes nothing, while a record whose body no longer matches its digest is reported instead of silently replaced. Corrections are new captures with `supersedes: [<capture-id>]`, never edits.

Decisions have no directory here. `assay intent promote --to decision` creates an ADR through the `adr` module with `related_intent` and `system` set.

`assay status` counts both intent directories as zones once the module is enabled.

### Intent in a private overlay

`assay attach --privacy private` keeps `.assay/` out of product commits and gives it no history of its own. Intent captures are the least reproducible records Assay holds — nothing else can reconstruct what was originally asked for — so storing them in a directory with no version history risks losing them to a single mistake. When intent is enabled in a private overlay, `assay check --advisories` recommends `--privacy private-git`, which initializes a separate Git repository inside `.assay/`. The advisory never fails the check.

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

Overlay can be detached into standalone by creating a sibling workbench, hoisting `.assay/references` to `references`, `.assay/analyses` to `analyses`, `.assay/intent` to `intent`, and registering the original product repo as an external independent primary system. Managed-file paths are rewritten to match, so nothing stays behind pointing at the old location. Use `assay convert --to standalone --target <sibling>`. Avoid in-place conversion unless explicitly requested with a destructive flag.
