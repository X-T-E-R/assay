
# .assay/

Assay runtime metadata. Do not store external evidence or long-lived user knowledge here.

- `managed-files.json`: fixed core asset baselines for no-clobber updates.
- `manifest.json`: framework version, exact layout, and expanded path entries.
- `systems-registry.json`: registered systems and the current primary system after `assay system register`.
- `events/`: JSONL event ledger.

- `backups/`: compatibility storage for existing rollback copies. Ordinary `assay update` leaves existing entries untouched and does not add retained backups.

Current Assay release is 0.14.0; layout release is 8.
