# Assay 0.12.0

Assay 0.12.0 is a breaking control-plane cleanup. It accepts and writes only `0.12.0+s4+l8`; older workspaces require an external cutover.

## Breaking changes

- Legacy workspace-shape runtime state is replaced by one-shot Templates. CLI: `--template`, `template list`, `template show`. Built-ins are exactly study/solve/explore; custom input is an explicit closed-schema-1 YAML path.
- Manifest schema 4 keeps only `__schema`, literal `framework_version`, and exact layout 8. `layout.entries` contains only expanded non-native Template paths. Project identity/name comes only from native `project.yaml`.
- Core no-clobber metadata moved to `.assay/managed-files.json` schema 1. Template output is user-owned.
- Global tracking is explicit via `workspace track|discover|list|forget` under `~/.assay/workspaces`. Lifecycle/read commands do not write it, and the former projects store is not read or migrated.
- User-authored event entrypoints and public event exports were removed. Automatic mutation events remain append-only.
- `.assay/VERSION` was removed.

## Preserved contracts

Systems registry schema 2 and authority are unchanged. Native Project/Task/Roadmap/Spec, Source/Analysis/Knowledge, and external Plugin schema 1 behaviors remain in place.
