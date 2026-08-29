# Workspace layout

Manifest schema 4 records one-shot Template expansion under `layout.entries`,
not a Template name or deterministic native/core paths. The envelope directory
below is `.assay/` for a workspace assay created and `.absorb/` for one absorb
created; the manifest's `layout.paths` spell the logical `.assay` prefix either
way.

## Standalone

```text
.assay/
  manifest.json
  managed-files.json
  events/
  backups/                     # compatibility storage; ordinary update adds nothing
  systems-registry.json        # created when Systems are registered
project/
  project.yaml                 # unique Project id/name authority
  README.md
  roadmap/                     # build half: Roadmap outcome records
  specs/                       # build half: Spec records
tasks/                         # build half: Task records
sources/                       # study half: external material and observations
analyses/                      # study half: bounded interpretations
knowledge/                     # study half: accepted reusable knowledge
systems/
<Template-expanded directories and files>
```

`assay init` creates the common scaffold and the build directories in one pass.
The study directories are created by the same common scaffold, so a workspace is
ready for both halves from the start.

## Overlay

The same logical work areas resolve under the envelope directory; the product
repository root remains the primary System. The layout 8 block contains the
exact resolver paths and privacy mode.

## Entries

Each `layout.entries` item is `{ path, kind: directory|file, purpose }`. Paths
are normalized, workspace-relative, unique, bounded, non-native Template output.
Status, check, and AGENTS generation combine these entries with the fixed native
resolver.

## Managed receipt

`managed-files.json` schema 1 records only fixed core files with `path`, exactly
one of `asset` or `generator`, `baseline_hash`, `protected`, and `executable`. It
is a separate authority file with the same fail-closed transaction boundary as
the manifest. Template output is user-owned and excluded. Records written by
another product in the pair are preserved rather than pruned.

Managed fixed-core and AGENTS writes use transient recoverable authority
transactions. A successful write, or recovery of an interrupted write, removes
its transaction stage and rollback artifact rather than retaining file history.
`backups/` remains in the layout for compatibility with existing rollback copies
and `.gitkeep`; ordinary `assay update` neither creates new entries nor changes
existing ones.
