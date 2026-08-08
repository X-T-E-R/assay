# Workspace Layout


## Standalone mode

Use standalone when the Assay workbench is the project: studying external systems, solving a measurable target, exploring directions, or cross-system learning.

```text
.assay/     manifest, Task context bindings, plugin receipts, version, events, migrations, backups, registries, archetypes
project/    required native Project envelope and native Roadmap items
tasks/      native bounded outcomes; created when the first Task is written
systems/    registered systems and system metadata
knowledge/  accepted reusable patterns, guides, and troubleshooting notes
```

Source and Analysis are native, lazy work areas for every archetype. `study` scaffolds them eagerly; `solve`, `explore`, and custom archetypes create `sources/` or `analyses/` on the first source/analysis command. Their absence is healthy and `status` still reports both zones.

Archetype-specific working directories sit alongside this base.

| Archetype | Adds |
| --- | --- |
| `solve` | `problem/`, `intake/`, `benchmarks/`, `attempts/`, `tools/`, `objective.json`, and `systems/current.json`. |
| `explore` | `approaches/`, `trials/`, and `comparison.md`. |

## Directory purposes

An archetype states what each directory is for, next to the directory itself:

```yaml
description: Attack one goal that has a measurable success criterion, using bounded attempts until the score moves.

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
for their parent. An archetype that wants the parent listed declares the parent.

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

Each Source stores its observation ledger under `sources/<alias>/` as `observations/`, `manifests/`, and `captures/`; frozen Sources force archive capture and cannot sync or switch.

## Native Task records

Every workspace can use `assay task` without installing a plugin. Task follows
the work root: standalone records live under
`tasks/<stable-id>/`, while overlay records live under
`.assay/tasks/<stable-id>/`. Each directory requires `task.json` and `prd.md`;
`handoff.md`, `design.md`, and `research/` are optional. Explicitly archived
terminal Tasks move under `tasks/archive/<stable-id>/`.

A Task preserves one bounded outcome across sessions, agents, compaction, and
attempts. `.assay/task-contexts.json` stores exact host-context bindings, but
Task never guesses current from active count, age, or title. It does not replace
dispatch state. See [Task records](task.md) for its lifecycle and command guide.

## External plugin metadata

The manifest's optional top-level `plugins` and `bindings` maps remain generic
schema 3 metadata. Core does not install, reconcile, execute, or remove a
built-in provider from those fields, and fresh `init`, `attach`, and `update`
workspaces do not create built-in receipt state.

Independently packaged descriptors use `.assay/external-plugins.json` schema 1.
Each record contains the validated descriptor, computed SHA-256 lock, Assay
enabled flag, and at most one host-reported observation. Descriptor
verification, Assay enablement, host installation, host activation, and health
remain separate. Missing host evidence stays `unobserved`/`unverifiable`.
Requested capabilities, scopes, and surfaces are opaque host requests, not
native Assay authority. Assay-owned paths must be safe and relative;
host-owned locators remain symbolic and are never resolved or deleted.
Removing a record never deletes the referenced package or host state.

Native Task is independent of plugin metadata. Its files own durable task
identity and lifecycle; the host runtime continues to own dispatch, agent DAGs,
execution permissions, and activation. Assay does not alias or import another
task store.

```yaml
__schema: 1
id: project-example-project
name: Example Project
authority:
  mode: native
  pointer: README.md
```

The schema is closed: extra fields, ids other than `project-<slug>`, other
authority modes, and other pointers fail `assay check`. The pointer is relative to the Project
root, so overlay-to-standalone conversion preserves both identity and meaning.
The `project.name`, `project.archetype`, and `project.mode` fields in
`.assay/manifest.json` remain workspace presentation/settings compatibility
data; the manifest is not a second Project charter or identity record.

## Source adoption operational receipts

Source adoption receipts live under the Assay state directory in both layout modes:

```text
.assay/donors/<adoption-id>/
  definitions/<digest>.json
  inspections/<inspection-id>.json
  evidence/<evidence-id>.json
  decisions/<decision-id>.json
  state.json
```

No archetype scaffolds the codec-stable internal `.assay/donors/` receipt store. The storage layer creates the directory and each adoption folder on demand, the first time `assay source adoption register` runs, so a workspace that never records a Source adoption relationship has no receipt directory at all. `assay check` validates these records only when they exist.

Definitions, inspections, evidence, and decisions are immutable content-addressed files; `state.json` is the current pointer (active definition, per-target baselines, committed decisions, generation). Use `assay source adoption` commands rather than editing them by hand. For the record semantics see [Source Adoption](source-adoption.md).

## Overlay mode

Use overlay when an existing product repo root should be the primary system. Assay writes one `.assay/` directory and keeps product files in place:

```text
.assay/
  manifest.json
  task-contexts.json
  systems-registry.json
  events/
  backups/
  systems/root.yaml
  sources/
  analyses/
  knowledge/
  tasks/
```

Overlay does not create root-level `sources/`, `analyses/`, `knowledge/`, `tasks/`, or `systems/` folders. It does not modify tracked root files by default.

## Runtime paths

Commands resolve paths through the manifest `layout` block. Do not hard-code `sources/` or `analyses/` at root. In standalone, those paths resolve to root-level folders. In overlay, they resolve under `.assay/`.

## Git expectations

Standalone Git is optional and belongs to the Assay workbench. Overlay Git belongs to the product repo and should ignore `.assay/` by default. `assay attach --privacy private` writes `/.assay/` to `.git/info/exclude` so product commits stay clean. If Assay state needs history in overlay without entering product Git, initialize a separate Git repository inside `.assay/` with `--privacy private-git`.

## Conversion

Overlay can be detached into a sibling standalone workbench. Conversion hoists
`.assay/sources`, `.assay/analyses`, `.assay/tasks`, and `.assay/project` to
their standalone locations. It carries current state such as
`.assay/task-contexts.json`, Source-adoption receipts, and
`.assay/external-plugins.json`, then rewrites managed Source and System paths.

Unknown state is never opened, followed, copied, moved, parsed, or deleted.
Copy leaves it at the source; `--move --no-keep-overlay` fails before target
creation. Task and native Project directories are never merged into non-empty
targets. Use `assay convert --to standalone --target <sibling>`.
