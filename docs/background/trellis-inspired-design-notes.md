# Trellis-Inspired Design Notes

MetaSystem Kit treats a framework workspace as local project infrastructure, not as a loose collection of prompts or notes. This direction was influenced by workflow systems that keep project rules, task state, update metadata, and assistant-facing instructions inside the repository.

The useful pattern is not any specific upstream implementation. The useful pattern is the separation of responsibilities:

```text
human-facing workspace
  + managed local system layer
  + CLI lifecycle commands
  + assistant-facing operating procedure
```

## Project Infrastructure, Not a Prompt Pack

A durable workflow system needs more than instructions. It needs files that can be checked, updated, and reviewed. MetaSystem Kit therefore gives each managed workspace a `.framework/` directory that stores version state, a manifest, events, migrations, and backups.

That managed layer sits beside the visible workspace:

```text
references/ -> analyses/ -> systems/ -> iterations/ -> knowledge/
```

The visible folders hold user artifacts. The hidden `.framework/` layer holds lifecycle metadata. This split keeps daily work readable while still allowing the framework to evolve safely.

## Indexes Should Be Discovery Surfaces

Large context files become hard to maintain and expensive for assistants to load. MetaSystem Kit favors small index files and scoped documents. A top-level README or index should tell readers what exists and when to open it; detailed reasoning belongs in specific analysis, decision, or iteration documents.

This is why the framework separates:

- `references/` for external material;
- `analyses/` for interpretation;
- `systems/` for the active local implementation;
- `iterations/` for planned changes and review;
- `knowledge/` for accepted reusable conclusions.

## Updates Need File Ownership

Safe updates require the framework to know which files it owns. MetaSystem Kit uses `.framework/manifest.json` to record managed files, template identifiers, installed versions, and hashes.

That enables update behavior such as:

- create new managed files when they are missing;
- auto-update files that still match the installed template hash;
- preserve user-modified managed files by default;
- respect user-deleted managed files;
- keep user artifacts outside template overwrite logic;
- require explicit migration for layout changes.

The important rule is simple: **framework templates can be updated; user knowledge must be protected**.

## Platform Adapters Come After the Core Model

Assistant-specific integrations are useful, but they should not decide the core workspace shape. MetaSystem Kit keeps the core artifact model independent first, then exposes assistant-facing Skills or agent metadata as adapters.

That keeps the framework useful even when the active assistant, editor, or automation surface changes.

## CLI Logic Should Be Testable

Repository-mutating commands are risky if they live in one large script or a process-only adapter. MetaSystem Kit splits reusable framework behavior from terminal concerns:

```text
packages/
├── metasystem-framework-core/
│   └── src/        # templates, manifests, events, workspace operations, updates
└── metasystem-framework-cli/
    └── src/        # Commander command definitions, formatting, exit-code mapping
```

This makes init, check, reference intake, update analysis, and migration planning testable as separate behaviors.
