<!-- ASSAY:START -->

# Assay Workspace Instructions

This workspace is managed by Assay.

- Run `assay prime` at the start of a session. It states the semantic contract below plus the current workspace state in one screen.
- Run `assay explain <object>` before using an object type for the first time. Topics: workspace, project, task, roadmap, spec, source, adoption, analysis, knowledge, system.
- Before changing workspace structure, start from the installed `assay-builder` skill if the agent environment exposes it. Otherwise use `assay --help` / `assay help <command>` and inspect the workspace with `assay status`.
- Do not assume the repository root is the system being built. The root is the Assay workspace/control surface. Systems live under `systems/` and registered systems are managed with `assay system ...`.
- Use Assay commands for `.assay/` state. Edits outside this block are preserved.

## Object semantics

- Project is the one identity and acceptance authority for this workspace. Most-broken rule: project acceptance never moves into a Task, a Roadmap item, or a commit.
- Task is one bounded outcome kept identifiable across sessions, agents, compaction, and repeated attempts. Most-broken rule: a new attempt at the same outcome is not a new Task.
- Roadmap is an intended Project outcome, with how firmly and how soon the Project wants it. Most-broken rule: an item is an outcome, not a plan of work; Tasks are how it gets there.
- Spec is the current normative constraint, addressable after the work that produced it is gone. Most-broken rule: activation validates structure; it is not approval or Project acceptance.
- Source is external material kept where its origin and its changes stay readable. Most-broken rule: record what this decision needs, not everything recordable.
- Source adoption is a mapping from source material to where it landed in a system, so a later upstream change can find it. Most-broken rule: it is a traceability record, not an approval workflow.
- Analysis is the working surface where a Source is read and a decision is reached. Most-broken rule: an Analysis is finished when it reaches an exit, not when the file exists.
- Knowledge is what survived a decision and is worth reusing. Most-broken rule: `knowledge/` is not an inbox; work in progress belongs in an Analysis.
- System registry is which directories in this workspace are systems being built, and which one is primary. Most-broken rule: exactly one system is primary, and the workspace root is not a system.

## Workspace layout

| Directory | What goes here |
| --- | --- |
| `sources/` | Living sources and frozen external evidence (created on first use) |
| `analyses/references/` | Analysis cards for external systems |
| `analyses/gaps/` | Gaps between an external system and this workspace |
| `analyses/patterns/` | Candidate reusable patterns awaiting validation |
| `project/` | Native Project authority |
| `systems/` | Registered systems and local implementations |
| `knowledge/` | Accepted reusable knowledge |
| `analyses/` | Analysis records (created on first use) |

<!-- ASSAY:END -->
