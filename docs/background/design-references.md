# Design references

| Concern | Authority |
| --- | --- |
| Workspace resolver and expanded paths | `.assay/manifest.json` schema 4 / layout 8 |
| Native Project id and name | `<work-root>/project/project.yaml` schema 1 |
| Core no-clobber baselines | `.assay/managed-files.json` schema 1 |
| Systems | `.assay/systems-registry.json` schema 3 map-key authority; no Assay-owned sidecar |
| Automatic audit events | `.assay/events/YYYY-MM.jsonl` |
| Optional global location index | `~/.assay/workspaces/*.json` schema 1 |

Template descriptors are one-shot inputs, not runtime authority.
