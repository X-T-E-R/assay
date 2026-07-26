# Next Release Draft

This draft tracks user-visible changes that should be reviewed before the next
Assay release version is chosen. Planned version: `0.4.0`.

## Capability Modules

Enabling a capability is no longer tied to the archetype chosen at init.

- `assay capability add <module>` scaffolds a module's directories, templates,
  and state files in an existing workspace, records the module under
  `project.capabilities` in the manifest, and appends a `capability.added`
  event. Existing files are never overwritten, and re-running on a module the
  workspace already has reports that and changes nothing.
- `assay capability list [--json]` shows every module and how the workspace
  obtained it: `archetype` for modules the archetype provides, `added` for
  modules enabled afterwards. A manifest entry this build does not implement is
  listed as unsupported rather than dropped.
- Paths are resolved through the workspace layout, so `capability add` in an
  overlay workspace scaffolds under `.assay/` and never into the attached
  product repository's root.
- Capability-scaffolded files are managed files: `assay update` reconciles them
  and `assay check` treats the module's directories as required structure.
- The effective capability set is the archetype's own modules plus the recorded
  ones. A workspace whose manifest predates the field keeps working unchanged.

## Product Intent

`intent` is the third capability module, alongside `adr` and `iteration`. No
archetype enables it by default; turn it on with `assay capability add intent`.

```bash
assay intent capture [--text <text> | --file <workspace-relative-path>] [--system <name>] [--source <text>] [--supersedes <ids>] [--force]
assay intent promote <capture> --to requirement|decision [--title <title>]
assay intent list [--system <name>] [--include-lineage] [--json]
```

- `capture` writes `intent/original/<YYYYMMDD>-<sha256:12>.md` holding the text
  verbatim, plus the resolved system name, the full SHA-256 of the body, and the
  capture time. `--file` is workspace-relative and refuses to leave the
  workspace.
- Captures are append-only. Identical text captured again is a no-op. Text whose
  record was edited after it was written is refused, naming the recorded and the
  current digest; corrections are recorded as a new capture with
  `--supersedes <capture-id>`.
- Every capture is scoped to one registered system, resolved at capture time, so
  a record keeps naming the system it was about after `system promote` moves the
  primary pointer. `intent list --system <name> --include-lineage` follows the
  registry `supersedes` chain across replacements.
- `promote --to requirement` writes `intent/requirements/<date>-<slug>.md`
  carrying `derives_from`. `promote --to decision` creates an ADR with
  `related_intent` and `system` set. There is no `intent/decisions/`; decisions
  stay in the ADR module.
- `assay status` counts both intent directories as zones once the module is
  enabled.

### Intent authority

`system register` and `system update` accept
`--intent-authority inline|external|none` with an optional `--intent-pointer`.
The registry record is the machine-readable home; the generated sidecar contract
mirrors the field. Absent means `inline`.

`intent capture` refuses to write for `external` and `none` and prints the
pointer. This is an authority boundary, not a policy check: Assay does not
verify the pointer is reachable. `--force` records the text anyway, marked
`shadow: true` and flagged in `intent list`, so a local convenience copy is never
mistaken for the authoritative record.

### Content boundary

Assay stores captured text as given and does not scan, redact, or classify it.
Removing credentials and personal data before capturing is the caller's
responsibility. See `docs/agent-instructions.md`.

## Convert Carries Intent

`assay convert --to standalone` hoists `.assay/intent` to `intent/` and rewrites
`intent/`-prefixed managed-file paths, alongside the work folders it already
moved. Without this, converting an overlay that had captured intent would leave
the records behind in the source `.assay/` and report every one of them as
missing in the new workspace.

## New Advisories

Both appear only under `assay check --advisories` and never fail the check.

- Intent enabled in a `privacy: private` overlay: `.assay/` is excluded from the
  product repository and has no history of its own, which is a poor home for the
  least reproducible records in the workspace. The advisory recommends
  `--privacy private-git`.
- A system with `status: superseded` that no other system records in its
  `supersedes` chain. `system promote` demotes the previous primary without
  writing a lineage link, so such a system is unreachable from the current
  primary and its intent drops out of `intent list --include-lineage`.

## Upgrade Notes

### One-way door: older Assay builds reject the new state files

Manifest and ADR-index schemas are strict, so a workspace touched by 0.4.0 may
not load in an earlier build:

- A manifest that records `project.capabilities` — written by
  `assay capability add` — fails validation on 0.3.0 and earlier.
- An `adrs.json` containing `related_intent` or `system` on any ADR — written by
  `assay intent promote --to decision` — fails validation on 0.3.0 and earlier.
- A systems registry containing `intent_authority` on any system — written by
  `system register`/`system update` — fails validation on 0.3.0 and earlier.

None of the three fields is written unless the corresponding command is used, so
a workspace that only runs the 0.3.0 command set stays readable by 0.3.0. Once
one of them is written there is no downgrade path other than removing the field
by hand. Upgrade every machine that shares a workspace before enabling
capabilities on it.

### No layout change

`LAYOUT_VERSION` stays at 4 and there is no migration. Everything added here is
additive and optional: the intent work folder is resolved through the work root
rather than the strict `layout.paths` map, so manifests written by either build
keep validating in the other as long as the fields above are absent.

### Nothing removed

No command, flag, or exported type was removed in this release. Existing
workspaces need no action to keep working; `intent` does nothing until it is
explicitly enabled.
