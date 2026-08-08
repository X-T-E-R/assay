# Assay 0.8.0

Assay 0.8.0 is a breaking workspace cutover release. It writes manifest schema
2 and layout 6 only.

## Workspace cutover

- Core accepts only the exact `0.8.0+s2+l6` workspace envelope.
- `0.7.0+s2+l5`, every other `.assay` tuple, and `.framework` workspaces fail
  closed with `WORKSPACE_CUTOVER_REQUIRED` before semantic records are read or
  changed.
- The error includes an observed tuple, the required tuple, and a
  non-executable `assay-cutover:<observed>->0.8.0+s2+l6` locator. Assay does not
  bundle or invoke a cutover implementation.

## Retired Iteration authority

- Layout 6 removes `paths.iterations`; fresh standalone and overlay workspaces
  do not scaffold an `iterations/` directory.
- Iteration commands, core APIs and types, templates, profile modules, status
  counts, check advisories, Knowledge back-references, convert ownership, and
  root-discovery markers are removed.
- A manually present `iterations/` directory in a current workspace is generic
  undeclared content. Assay does not parse or relocate it.
- Built-in `solve` and `explore` profiles keep their domain-specific attempts,
  trials, comparisons, and tools without an Iteration module.

Native Task owns future bounded work. This release does not generate Tasks from
retired records, infer Task or Roadmap fields, map statuses, promote old plans,
or apply any real workspace cutover. Task and Roadmap authority remain
independent.

## Preserved surface

Capability commands, fields, and scaffolding remain supported with the
`intent` module. Native Project, Task, Roadmap, Spec, System, Source, Analysis,
Knowledge, Intent requirements, generic plugin descriptors and bindings,
Ponytail metadata, donor decisions, and the Trellis runtime remain supported.

No package has been published or tagged from this draft.
