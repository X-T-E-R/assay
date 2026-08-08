# Assay

**Study many. Grow your own.**

Assay turns sources, experiments, and AI-assisted research into decisions your repo can remember.

Run it as a standalone workbench, or attach it privately to the repo you already ship.

> 中文版: [README.zh.md](README.zh.md)

## What Assay does

Your agent can inspect twenty repositories in an afternoon. Without a workbench, the useful parts disappear into chat scrollback: what mattered, what failed, what was adopted, and why the next agent should not start over.


The loop is simple:

```text
sources / experiments / goals
        -> structured analysis + checks
        -> knowledge, systems, and bounded Tasks
```

It is not a notes app, not an agent runtime, and not a prompt collection. It is the place where "this project does something interesting" becomes "we copied this pattern, rejected that claim, and can explain the decision later."

## Choose how to start

Assay fits the way your code already lives.

| Mode | Use it when | Where Assay writes | Git posture |
| --- | --- | --- | --- |
| `standalone` | You want a dedicated study / solve / explore workspace. | `.assay/` for Assay state, with work folders such as `tasks/`, `sources/`, `analyses/`, `knowledge/`, and `systems/` at the workspace root. | Optional workbench Git. Independent systems keep their own Git. |
| `overlay` | You already have a product repo and want its root to be the primary system. | One private `.assay/` folder containing Assay state and work folders. Product files stay where they are. | Product Git ignores `.assay/` by default; Assay state can optionally have its own Git inside `.assay/`. |

## Choose what you're building

Archetypes shape the workspace structure and defaults. They are **structure + conventions + common verbs**, not separate command families.

| If you want to... | Start with | Assay gives you |
| --- | --- | --- |
| Study external projects without losing provenance | `study` | living and frozen Sources, Source analyses, pattern notes, decision exits |
| Work toward a measurable target | `solve` | objectives, intake, attempts, benchmarks, tools |
| Explore several possible directions | `explore` | approaches, trials, comparison notes |


## Keep one outcome intact across context resets

`assay task` gives one bounded outcome a stable identity across sessions,
agents, compaction, and repeated attempts. A Task is a plain directory with a
machine-readable `task.json` envelope and a reader-editable `prd.md` contract.
Add `handoff.md` only when another session or agent needs a real continuation
checkpoint. Several Tasks can be active at once, including Tasks with the same
title; records use readable stable ids such as `task-0001-ship-native-task`.

Tasks live in `tasks/<id>/` in standalone workspaces and
`.assay/tasks/<id>/` in overlays. Finishing a Task records its lifecycle state;
it does not archive files, commit Git changes, accept the result, change a
roadmap, or promote Relay state.

`current` also refuses to guess. An explicit Task id wins, then an exact host
context binding in `.assay/task-contexts.json`; otherwise there is no current
Task. Assay never chooses by active count, creation time, or title. See [Task
records](docs/task.md) for the file contract, lifecycle, relationships, and
authority boundaries.

## Keep Project, Roadmap, and Spec authority explicit

Every workspace has exactly one native Project: `project/` in standalone workspaces and `.assay/project/` in overlays. Project ids use `project-<slug>`. `README.md` explains authority boundaries. Roadmap items live under `roadmap/<roadmap-id>/`, with closed machine state in `item.yaml` and reader-owned outcome prose in `outcome.md`; the root `roadmap/README.md` is explanatory, not a dynamic index. Native Specs are lazy under `specs/<spec-id>/{spec.yaml,specification.md}` and explicitly promote current constraints from Analysis or Task without changing their source. Project-selected `relay/` and `extensions/` remain lazy. Sources, analyses, Tasks, Systems, and `.assay/` runtime state retain their own authority. See [Roadmap items](docs/roadmap.md) and [Native specifications](docs/spec.md).


## Register external plugin metadata

External plugins are hosted and executed outside Assay. Register a packaged
descriptor only after the workspace exists:

```bash
assay init ../product-assay --name Product
assay plugin register ./assay-plugin.json
assay plugin observe ./host-observation.json
assay plugin list
assay plugin check
assay plugin disable <external-id>
assay plugin enable <external-id>
assay plugin remove <external-id>
```

Assay locks exact descriptor and artifact metadata in
`.assay/external-plugins.json` (schema 1). A matching host observation keeps
descriptor verification, Assay enablement, host installation/activation, and
health separate. These commands never install, activate, deactivate,
uninstall, import, or execute an external package. Host-owned locators remain
opaque and are never resolved or deleted by Assay.

The manifest's optional generic `plugins` and `bindings` fields remain part of
schema 3, but core does not install or reconcile built-ins from them. Fresh
workspaces do not create built-in plugin receipt state.

This repository includes the unpublished metadata/control-plane descriptor
`packages/assay-plugin-ponytail/assay-plugin.json`. It references Ponytail as
an external artifact; it does not install or execute Ponytail and does not
imply upstream endorsement.

## Quick start

Build and link the CLI from this repository:

```bash
git clone https://github.com/X-T-E-R/assay.git
cd assay
pnpm install
pnpm build
cd packages/assay-cli && npm link && cd ../..
```

Create a standalone study workspace:

```bash
assay init ../assay-study --name AssayStudy --archetype study --no-track
cd ../assay-study
assay check
assay source add https://github.com/<owner>/<project> sample
assay analysis new "Review sample" --for-source sample
assay event capture --kind decision --text "Adopt hero + before/after; reject unsupported benchmark claims"
assay check
```

Attach Assay privately to a repo whose root is the primary system:

```bash
cd /path/to/existing-repo
assay attach --name ExistingRepo --archetype study --privacy private
assay check
```

In overlay mode the product repo stays the product repo. Assay registers the repo root as the primary system and keeps its own work under `.assay/`. Product Git ignores `.assay/`, so `git status` stays clean.

`assay check` defaults to workspace structure and persisted-record integrity.
Use `assay check --advisories` when you also want reminders about unfinished
drafts, pending queues, adoption archives, or major
source changes. Those reminders are optional and never turn ordinary workflow
state into a failing check.

If you later want to separate the overlay into a standalone workbench, detach it without moving your product repo:

```bash
assay convert --to standalone --target ../existing-repo-assay
```

## Use it with an agent

The repo ships an agent-facing Skill at `skills/assay-builder`. It calls this clone's CLI directly, so keep the cloned repo in place after installing:

```bash
git clone https://github.com/X-T-E-R/assay.git assay
cd assay
node scripts/install.mjs
```


See `skills/assay-builder/references/cli-setup.md` for setup flags and invocation details.

## Git model

Assay separates system code from Assay memory.


In `overlay` mode, Assay should not enter your product repo by default. `assay attach --privacy private` writes `/.assay/` to the repo-local `.git/info/exclude` and leaves tracked project files alone. If you want versioned Assay memory without polluting product commits, use `--privacy private-git` to initialize a separate Git repository inside `.assay/`.

## What Assay deliberately does not do


## Learn more

- [Layout modes](docs/layout-modes.md)
- [Command reference](docs/commands.md)
- [Task records](docs/task.md)
- [Source adoption](docs/source-adoption.md)
- [Workspace layout](docs/workspace-layout.md)
- [Contributing](CONTRIBUTING.md)

If Assay saves you from re-reading the same sources twice, star it so other agent builders can find it.

---

linux.do
