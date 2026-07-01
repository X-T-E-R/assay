# Assay handoff notes

This page is a sanitized continuation note for maintainers of Assay itself. It records durable project facts that are safe to publish. Private task prompts, local machine paths, project-specific validation logs, and one-off review instructions belong in Trellis tasks or developer journals, not in this public documentation tree.

## Runtime facts to preserve

- Assay workspaces store project identity in `.framework/manifest.json` under `project.archetype` and `project.mode`.
- Layout v3 keeps active-system identity in `.framework/systems-registry.json`; each registered system owns a `systems/<name>/system.yaml` contract.
- ADR metadata lives in `.framework/adrs.json`, while human-readable ADR files live under `knowledge/decisions/`.
- Living external sources use `assay source add` and live under `references/<alias>/` with `source.yaml`, `checkout/`, `materials/`, `history.md`, and an internal observation ledger.
- Frozen references remain available for legacy or explicit full-capture evidence, but a frozen reference is unfinished until an analysis cites it or marks it analyzed.
- `assay check` is a structure and content-health check. It should not report a workspace as healthy just because files exist.

## Maintainer workflow

1. Build and test the packages from the Assay repository root with the documented package scripts.
2. Verify workspace changes through the CLI, not by hand-editing managed files.
3. Keep public docs aligned with the current command name, package names, and manifest-backed project model.
4. Keep historical decisions only when they explain current behavior or migration constraints.

## Public documentation boundary

Public docs may explain stable behavior, migration constraints, and release-facing workflows. They should not include:

- absolute local paths from a developer machine;
- private project names from unrelated validation runs;
- branch-specific handoff checklists;
- raw review prompts or agent orchestration instructions;
- stale package, command, or skill names from earlier implementations.
