# Assay 0.11.0

Assay 0.11.0 is a breaking workspace cutover release. It accepts and writes
manifest schema 3, layout 7, and systems-registry schema 2 without raising any
of those schema versions.

## Workspace cutover

- Core accepts only the exact `0.11.0+s3+l7` workspace envelope.
- `0.10.0+s3+l7`, every other `.assay` tuple, and `.framework` workspaces fail
  closed with `WORKSPACE_CUTOVER_REQUIRED` before plugin, archetype, System, or
  other workspace semantics are read or changed.
- The error includes the observed tuple, required tuple, and non-executable
  `assay-cutover:<observed>->0.11.0+s3+l7` locator. Assay does not bundle or
  invoke a cutover implementation.

## Built-in runtime removal

- The built-in workspace runtime, aliases, registry definition, installation
  receipts, reconcile lifecycle, host hooks, migration writers, and CLI command
  family are removed.
- Fresh workspaces do not create built-in plugin declarations, receipt state,
  runtime state, hooks, or migration records.
- The manifest's optional generic `plugins` and `bindings` fields remain in
  schema 3. They are metadata only; core does not install or reconcile a
  built-in from them.
- Native Task remains the Assay task lifecycle. Its records are not aliased to
  or populated from another task store. Host runtimes continue to own dispatch,
  agent DAGs, execution permissions, and activation.

## External plugin control plane

- `.assay/external-plugins.json` remains schema 1.
- Register, observe, list, check, enable, disable, and remove remain available
  for independently packaged descriptors.
- Requested capabilities/scopes/surfaces remain opaque host metadata. Assay
  does not install, activate, execute, or uninstall payloads and never resolves
  or deletes host-owned locators.
- The unpublished Ponytail descriptor continues through this same generic,
  host-owned execution boundary.

## Overlay conversion

- Current Source-adoption and external-plugin state still transfer under their
  existing contracts.
- Unknown state is not opened, followed, copied, moved, parsed, rewritten, or
  deleted. Copy leaves it at the source. A destructive
  `--move --no-keep-overlay` conversion fails before target creation when an
  unknown residual exists.

No package has been published or tagged from this draft.
