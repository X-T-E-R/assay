# Assay 0.9.0

Assay 0.9.0 is a breaking workspace cutover release. It accepts and writes
only manifest schema 3 with layout 6. The systems registry is schema 2.

## Workspace cutover

- Core accepts only the exact `0.9.0+s3+l6` workspace envelope.
- `0.8.0+s2+l6`, every other `.assay` tuple, and `.framework` workspaces fail
  closed with `WORKSPACE_CUTOVER_REQUIRED` before archetype, plugin, System, or
  other workspace semantics are read or changed.
- The error includes the observed tuple, required tuple, and non-executable
  `assay-cutover:<observed>->0.9.0+s3+l6` locator. Assay does not bundle or
  invoke a cutover implementation.
- A schema 1 systems registry, or a current registry carrying the removed
  `intent_authority` field, fails validation instead of being ignored.

## Removed core surfaces

- The core capability abstraction is removed: no capability commands, manifest
  field, archetype modules, scaffolds, gates, projections, events, or plugin
  contribution bridge remain.
- Native Intent capture, listing, promotion, integrity, System authority,
  templates, zones, and conversion behavior are removed.
- The built-in `assay.intent` plugin and its alias are removed.
- Fresh `init`, `attach`, and `update` do not create plugin declarations or
  receipts. Add a retained plugin later through an explicit plugin command.
- Custom archetypes carrying any `modules` key fail before the first workspace
  write. Other custom directories and templates continue to work.

Manually present `intent/` or `.assay/intent/` directories are generic,
undeclared content. Assay does not parse, copy, move, rewrite, or delete them.

## Preserved surface

External descriptor `requests.capabilities` and status
`requestedCapabilities` remain opaque host requests. They grant no native
Assay authority. Trellis `runtimeCapabilities` also remains unchanged.

Native Project, Roadmap, Spec, Task, System, Source, Analysis, Knowledge, Donor,
generic plugin state and reconcile, external Plugin/Ponytail metadata, and the
built-in Trellis runtime remain supported.

No package has been published or tagged from this draft.
