# Systems registry schema 3

`.assay/systems-registry.json` is the sole Project-local authority for System membership, canonical selectors, locators, lifecycle, VCS/version observations, and supersedes edges. Independent repositories retain their own Git, package, README, tag, and release identity.

```json
{
  "__schema": 3,
  "primary": "current",
  "systems": {
    "current": {
      "path": "systems/current",
      "status": "primary",
      "vcs": "embedded",
      "vcs_ref": "",
      "version": "1.0.0",
      "supersedes": ["previous"]
    },
    "previous": {
      "path": "systems/previous",
      "status": "superseded",
      "vcs": "independent-git",
      "vcs_ref": "v0.9.0",
      "version": "0.9.0",
      "supersedes": [],
      "absorbed_on": "2026-08-08"
    }
  },
  "updated_at": "2026-08-08T00:00:00.000Z"
}
```

The map key is the exact selector; a record never repeats a name. Records are closed and contain no contract locator. Exactly one record is `primary` and must match the top-level pointer. Non-archived normalized locators are unique. `supersedes` targets must exist and the graph must contain no self edge, duplicate edge, or cycle.

Lifecycle fields are status-paired:

- `primary` and `active` carry no transition date;
- `superseded` carries only `absorbed_on`;
- `archived` carries only `archived_on`.

Assay 0.13 implements logical archive only. It does not record a physical archive path and never copies, moves, or deletes registered bytes. Absolute external locators remain external and are never reclassified as workspace-owned. `system update --path` only rebinds the registry.

## Commands

```text
assay system register <path> [--name <selector>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--primary] [--supersedes <selectors>]
assay system update <selector> [--path <path>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--primary] [--supersedes <selectors>]
assay system promote <selector>
assay system archive <selector> [--dry-run | --apply]
assay system list [--status primary|active|superseded|archived] [--json]
assay system show <selector> [--json]
```

Selectors are exact; there is no prefix fallback. The first registered System becomes primary. Promoting another System marks the previous primary `superseded` and records `absorbed_on`.

## Ordinary files and cutover

A file named `system.yaml` is ordinary user content. Core does not create, parse, validate, repair, or delete it, and its bytes cannot repair or override registry state.

Assay 0.13 accepts only registry schema 3. An r2 registry fails closed before System semantic reads, locator dereference, authority recovery, or writes and reports the non-executing exact-pair cutover locator. Core contains no r2 migration reader or writer.

Core integrations that replace the whole registry must load a registry snapshot and pass its exact `revision` to `saveSystemsRegistry`. First creation passes `expectedRevision: null`; a stale or missing baseline is an authority conflict rather than permission to overwrite concurrent membership.
