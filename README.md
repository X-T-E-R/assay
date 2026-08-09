# Assay

Assay is a local-first evidence workbench for Projects, Sources, Analyses, Knowledge, Tasks, Roadmaps, Specs, and independently versioned Systems.

Repository installation and the packaged CLI require Node.js >=22.13.0. This
repository pins pnpm 11.3.0 through `packageManager`.

## 0.13 workspace contract

Assay 0.13 accepts only `0.13.0+s4+l8+r3`. Older or malformed workspace or System-registry envelopes fail closed. Compatible updates stay native; when Assay reports a cutover locator, follow [Major workspace cutovers](docs/legacy-cutover.md).

- `.assay/manifest.json` schema 4 stores only the literal framework version and exact layout 8 block. `layout.entries` contains only bounded, expanded one-shot Template paths; deterministic native/core paths are resolved rather than duplicated.
- `project/project.yaml` (or `.assay/project/project.yaml` in overlay mode) is the single native Project id/name authority.
- `.assay/managed-files.json` schema 1 is the no-clobber receipt for fixed core assets. One-shot Template output is user-owned and never enters this receipt.
- `.assay/systems-registry.json` schema 3 is the sole Project-local System authority. Its map key is the canonical selector; records contain only locator, lifecycle, VCS/version observations, and supersedes edges. Assay neither creates nor interprets `system.yaml`.
- External Plugin descriptors remain schema 1 metadata; Assay does not install or execute their payloads.

## Start

```bash
assay init ../assay-study --name AssayStudy --template study
assay template list
assay status --root ../assay-study
assay check --root ../assay-study
```

Built-in one-shot Templates are `study`, `solve`, and `explore`. A custom Template is accepted only as an explicit `.yaml`/`.yml` path. Its closed schema is:

```yaml
__schema: 1
description: A one-line purpose.
directories:
  - path: notes
    purpose: Reader-owned notes
files:
  - path: notes/README.md
    content: "# Notes\n"
```

Each file declares exactly one of `content` or a descriptor-relative `file`; `executable` is optional. Absolute, traversal, retired, redirected, and legacy Template fields fail before the first scaffold write. Template identity is not persisted, so status, check, update, and convert do not need the descriptor afterwards.

## Attach and convert

```bash
assay attach --root ../product --name Product --template study --privacy private
assay convert --root ../product --to standalone --target ../product-workbench --copy
```

Standalone keeps work areas at the workspace root. Overlay keeps Assay state and work areas under `.assay/` while the product repository root remains the primary System.

## Explicit workspace index

Normal lifecycle and read commands never touch global state. Tracking is opt-in:

```bash
assay workspace track ../assay-study
assay workspace discover ../work
assay workspace list
assay workspace forget ../assay-study
```

Records live under `~/.assay/workspaces` (override: `ASSAY_WORKSPACES_ROOT`), are keyed by canonical-path hash, and contain only schema 1 `project_id` plus canonical `path`. Multiple clones of one Project are allowed. `--rebind <old>` is explicit and requires the same Project id.

See [docs/commands.md](docs/commands.md), [docs/workspace-layout.md](docs/workspace-layout.md), [docs/layout-modes.md](docs/layout-modes.md), [docs/task.md](docs/task.md), [docs/roadmap.md](docs/roadmap.md), [docs/spec.md](docs/spec.md), and [docs/source-adoption.md](docs/source-adoption.md).
