# Design Principles

Assay treats a framework workspace as local project infrastructure, not as a loose collection of prompts or notes. A useful workspace keeps project rules, task state, update metadata, and assistant-facing instructions close to the work they govern.

The core pattern is a separation of responsibilities:

```text
human-facing workspace
  + managed local system layer
  + CLI lifecycle commands
  + assistant-facing operating procedure
```

## Project Infrastructure, Not a Prompt Pack

A durable workflow system needs more than instructions. It needs files that can be checked, updated, and reviewed. Assay therefore gives each managed workspace a `.assay/` directory that stores the manifest, the managed-file receipt, events, backups, and native operational state.

That managed layer sits beside the visible workspace:

```text
sources/ -> analyses/ -> systems/ + knowledge/
```

The visible folders hold user artifacts. The hidden `.assay/` layer holds lifecycle metadata. This split keeps daily work readable while still allowing the framework to evolve safely.

## Indexes Should Be Discovery Surfaces

Large context files become hard to maintain and expensive for assistants to load. Assay favors small index files and scoped documents. A top-level README or index should tell readers what exists and when to open it; detailed reasoning belongs in specific Analysis, Task, or knowledge documents.

This is why the framework separates:

- `sources/` for external material;
- `analyses/` for interpretation;
- `systems/` for the active local implementation;
- `tasks/` for bounded outcomes that must survive context changes;
- `knowledge/` for accepted reusable conclusions.

## Updates Need File Ownership

Safe updates require the framework to know which fixed core files it owns. Assay uses `.assay/managed-files.json` for their generators or assets, baseline hashes, protection flags, and executable bits. `.assay/manifest.json` separately records the exact framework/layout envelope plus bounded paths expanded from a one-shot Template; it does not persist Template identity or managed-file hashes.

That enables update behavior such as:

- create new fixed core files introduced by the current release;
- auto-update files that still match their managed-receipt baseline hash;
- preserve user-modified managed files by default;
- respect user-deleted managed files;
- keep user artifacts outside template overwrite logic;
- fail closed at a workspace-contract cutover instead of rewriting an unsupported layout.

The important rule is simple: **framework templates can be updated; user knowledge must be protected**.

## Platform Adapters Come After the Core Model

Assistant-specific integrations are useful, but they should not decide the core workspace shape. Assay keeps the core artifact model independent first, then exposes assistant-facing Skills or agent metadata as adapters.

That keeps the framework useful even when the active assistant, editor, or automation surface changes.

## Tools Should Not Become Universal Gates

Assay is a plain-file evidence and decision workbench. Commands should make
inspection, reminders, evidence capture, and lifecycle history available
without assuming every project needs the same ceremony.

The blocking boundary is narrow:

- refuse operations that would corrupt or contradict persisted records;
- refuse destructive refreshes when unrecorded checkout work could be lost;
- enforce policy only when the workspace explicitly declares it `required`;
- otherwise record the fact, emit an advisory when requested, and let the
  caller decide.

`assay check` therefore defaults to structure and persisted-record integrity.
Workflow and content reminders are available through `assay check
--advisories`. External governance markers can explain possible duplicate
records, but they do not override an explicit Assay command. Text heuristics
can identify unfinished drafts; they cannot establish the quality of an
analysis and must not block an explicit close.

## CLI Logic Should Be Testable

Repository-mutating commands are risky if they live in one large script or a process-only adapter. Assay splits reusable framework behavior from terminal concerns:

```text
packages/
├── assay-core/
│   └── src/        # templates, manifests, events, workspace operations, updates
└── assay-cli/
    └── src/        # Commander command definitions, formatting, exit-code mapping
```

This makes init, check, Source intake, update analysis, and conversion planning testable as separate behaviors.
