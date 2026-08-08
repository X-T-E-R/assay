# Assay 0.7.0

Assay 0.7.0 is a breaking workspace cutover release. It writes manifest schema
2 and layout 5 only.

## Workspace cutover

- Core accepts only the exact `0.7.0+s2+l5` workspace envelope.
- Older `.assay` layouts and `.framework` workspaces fail closed with
  `WORKSPACE_CUTOVER_REQUIRED` before their records are loaded or changed.
- The error includes an observed tuple, the required tuple, and a
  non-executable `assay-cutover:<observed>->0.7.0+s2+l5` locator. Assay does not
  bundle or invoke a cutover implementation.
- Retired layout and Project-authority compatibility commands are absent.

## Removed surface

- The architecture-record module, its index, commands, templates, provider
  responsibility, source hints, and intent promotion target were removed.
- Analysis exits are `adopt`, `reject`, and `experiment`.
- Knowledge types are `pattern`, `guide`, and `troubleshooting`.

## Preserved surface

Native Project, Task, Roadmap, Spec, System, Source, Analysis, Knowledge,
Intent requirements, generic plugin descriptors and bindings, Ponytail
metadata, donor decisions, and the Trellis runtime remain supported.

No package has been published or tagged from this draft.
