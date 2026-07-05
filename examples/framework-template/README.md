
# Assay

A versioned Assay workspace.

Evidence loop:

```text
evidence in -> structured checks -> decisions -> knowledge growth
```

| Path | Purpose |
| --- | --- |
| `.assay/` | Runtime metadata: version, manifest, events, migrations, backups |
| `systems/` | Registered active systems and local implementations |
| `knowledge/` | Accepted reusable knowledge |

Archetype-specific working directories sit alongside this base. Use `assay status` to inspect open work and `assay check` to validate the workspace.
