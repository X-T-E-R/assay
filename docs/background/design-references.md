# Design references

| Concern | Authority |
| --- | --- |
| Workspace resolver and expanded paths | `.assay/manifest.json` schema 4 / layout 8 |
| Native Project id and name | `<work-root>/project/project.yaml` schema 1 |
| Core no-clobber baselines | `.assay/managed-files.json` schema 1 |
| Native Tasks and exact host-context bindings | `<work-root>/tasks/` plus `.assay/task-contexts.json` |
| Native Roadmap outcomes | `<work-root>/project/roadmap/` |
| Native Specifications | `<work-root>/project/specs/` |
| Source observations and material | `<work-root>/sources/` |
| Source adoption mappings | `.assay/source-adoptions/<id>.json` schema `assay.source-adoption/v1` |
| Systems | `.assay/systems-registry.json` schema 3 map-key authority; no Assay-owned sidecar |
| External Plugin metadata | `.assay/external-plugins.json` schema 1; host owns execution |
| Automatic audit events | `.assay/events/YYYY-MM.jsonl` |
| Optional global location index | `~/.assay/workspaces/*.json` schema 1 |

Template descriptors are one-shot inputs, not runtime authority.
