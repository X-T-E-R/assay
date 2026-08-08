# Workspace layout

Manifest schema 4 records one-shot Template expansion under `layout.entries`, not a Template name or deterministic native/core paths.

## Standalone

```text
.assay/
  manifest.json
  managed-files.json
  events/
  backups/
  systems-registry.json        # created when Systems are registered
project/
  project.yaml                 # unique Project id/name authority
  README.md
  roadmap/README.md
systems/
knowledge/
<Template-expanded directories and files>
```

## Overlay

The same logical work areas resolve under `.assay/`; the product repository root remains the primary System. The layout 8 block contains the exact resolver paths and privacy mode.

## Entries

Each `layout.entries` item is `{ path, kind: directory|file, purpose }`. Paths are normalized, workspace-relative, unique, bounded, non-native Template output and are rewritten losslessly during overlay-to-standalone conversion. Status, check, AGENTS generation, placement advisories, and conversion combine these entries with the fixed native resolver.

## Managed receipt

`.assay/managed-files.json` schema 1 records only fixed core files with `path`, exactly one of `asset` or `generator`, `baseline_hash`, `protected`, and `executable`. It is a separate authority file with the same fail-closed transaction boundary as the manifest. Template output is user-owned and excluded.
