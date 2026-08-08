<!-- ASSAY:START -->

# Assay Workspace Instructions

This workspace is managed by Assay.

- Before changing workspace structure, start from the installed `assay-builder` skill if the agent environment exposes it. Otherwise use `assay --help` / `assay help <command>` and inspect the workspace with `assay status`.
- Do not assume the repository root is the system being built. The root is the Assay workspace/control surface. Systems live under `systems/` and registered systems are managed with `assay system ...`.
- Use Assay commands for `.assay/` state. Edits outside this block are preserved.

## Workspace layout (archetype: study)

Study external systems as the main product, converting what survives analysis into reusable knowledge.

| Directory | What goes here |
| --- | --- |
| `sources/` | Living and frozen external evidence |
| `analyses/references/` | Analysis cards for external systems |
| `analyses/gaps/` | Gaps between an external system and this workspace |
| `analyses/patterns/` | Candidate reusable patterns awaiting validation |
| `project/` | Native Project charter, roadmap, specifications, selected Relay records, and extensions |
| `systems/` | Registered systems and local implementations |
| `knowledge/` | Accepted, reusable knowledge |
| `analyses/` | Analysis records (created on first use) |

<!-- ASSAY:END -->
