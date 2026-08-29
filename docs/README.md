# Documentation

## Architecture

Assay 0.15 is a stitching layer over two independent products:

- **study half** — [`absorb-anything`](https://github.com/NB-Corp/absorb-anything):
  the `absorb-anything-core` package owns the shared envelope, manifest, layout,
  managed receipt, and the Source/Analysis/Knowledge objects; the
  `absorb-anything` package owns the `absorb` CLI.
- **build half** — [`own-work`](https://github.com/NB-Corp/own-work): the
  `own-work` package owns Task, Roadmap, Spec, and System plus the `ownwork` CLI.

The `assay` package adds three things and nothing else: the suite lifecycle
commands (`init`, `check`, `status`, `prime`, `explain`), the merged object table
those commands read, and the mount that re-parents both halves' remaining
commands under one binary. Object behaviour, storage formats, and authority
rules live in the halves — their repositories are the reference for anything
below the suite surface.

One consequence worth stating plainly: the physical envelope is `.assay/` when
assay created the workspace and `.absorb/` when absorb did, and every tool reads
whichever is present. The two products share one workspace shape.

## This repository

- [commands.md](commands.md) — the merged CLI surface, what the suite owns, what
  is mounted from each half, and what is deliberately absent.
- [layout-modes.md](layout-modes.md) — standalone (assay's default) versus
  overlay, and how the physical envelope is chosen.
- [workspace-layout.md](workspace-layout.md) — manifest schema 4, layout 8
  entries, native Project, and the managed receipt.
- [agent-instructions.md](agent-instructions.md) — the managed `AGENTS.md` block.
- [legacy-cutover.md](legacy-cutover.md) — boundary and handoff for external
  major workspace cutovers.

## Object references

These describe storage formats and authority rules that 0.15 inherits unchanged
from the halves. They remain accurate for the mounted commands.

- [task.md](task.md) — Task identity, lifecycle, checkpoints, bindings, relations.
- [roadmap.md](roadmap.md) — Roadmap outcomes, graph rules, Task links.
- [spec.md](spec.md) — Spec storage, promotion, lifecycle, authority boundaries.
- [source-reference.md](source-reference.md) — cross-workspace Source references,
  write-through, and the clone registry.

## Historical

- [source-adoption.md](source-adoption.md) — Source adoption mappings. The
  commands are **not mounted in 0.15**; the document describes the 0.14 records.
- [architecture/README-assay-v2.zh-CN.md](architecture/README-assay-v2.zh-CN.md)
  — design proposal index for same-shape workspaces plus cross-workspace Source
  references (V2), with design history.
