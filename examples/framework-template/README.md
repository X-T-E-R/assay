
# Assay

A versioned Assay workspace.

Evidence loop:

```text
evidence in -> structured checks -> decisions -> knowledge growth
```

| Path | Purpose |
| --- | --- |
| `.assay/` | Runtime metadata: manifest, managed receipt, events, and compatibility backup storage |
| `project/` | Native Project identity, charter, and Roadmap items |
| `systems/` | Registered active systems and local implementations |
| `knowledge/` | Accepted reusable knowledge |

One-shot Template working directories sit alongside this base. Use `assay status` to inspect open work and `assay check` to validate the workspace.
