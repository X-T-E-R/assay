
# .framework/

Framework runtime metadata. Do not store external research or long-lived user knowledge here.

- `VERSION`: installed framework template version.
- `manifest.json`: managed file hashes and template IDs.
- `systems-registry.json`: registered systems and the current primary system.
- `adrs.json`: ADR numbering and status index, created when ADR commands are used.
- `events/`: JSONL event ledger.
- `migrations/`: migration notes and plans.
- `backups/`: timestamped backups before update/migration.

Current template version: 0.2.0; layout version: 3.
