
# .assay/

Assay runtime metadata. Do not store external evidence or long-lived user knowledge here.

- `managed-files.json`: fixed core asset baselines for no-clobber updates.
- `manifest.json`: framework version, exact layout, and expanded path entries.
- `systems-registry.json`: registered systems and the current primary system after `assay system register`.
- `events/`: JSONL event ledger.

- `backups/`: timestamped backups before managed updates.

Current Assay release is 0.12.0; layout release is 8.
