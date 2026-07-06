
# .assay/

Assay runtime metadata. Do not store external evidence or long-lived user knowledge here.

- `VERSION`: installed template version.
- `manifest.json`: managed file hashes and template IDs.
- `systems-registry.json`: registered systems and the current primary system after `assay system register`.
- `adrs.json`: ADR numbering and status index when the archetype enables ADRs.
- `events/`: JSONL event ledger.
- `migrations/`: migration notes and plans.
- `backups/`: timestamped backups before update or migration.

Current template release is 0.2.0; layout release is 4.
