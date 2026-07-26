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

## Directories That Explain Themselves

An archetype can now state what each of its directories is for, and that
statement reaches every surface that shows the directory.

```yaml
description: Attack one goal that has a measurable success criterion, iterating until the score moves.

dirs:
  - path: problem
    purpose: Task statement, official rules, scoring definition
  - path: intake
    purpose: Raw deliveries that have not been normalized yet
```

- `dirs` entries accept `{ path, purpose }` alongside the original bare string,
  which stays valid and declares no purpose. Archetypes written before this
  release load unchanged.
- An archetype gains a one-line `description`.
- Every built-in archetype now carries real purposes and a description.
- `solve` ships the `problem/README.md` it was missing.

Three surfaces read the declarations, so a custom archetype gets all three
without touching Assay:

- **`AGENTS.md`**: the managed block appends a workspace layout section — the
  archetype's description and a table of its directories — generated from the
  archetype rather than hardcoded. `assay update --agents` regenerates it, and
  `assay check --advisories` reports a block that no longer matches.
- **`assay status`**: zones are derived from the installed archetype and its
  enabled capability modules instead of a fixed list of `study` directories. A
  solve workspace no longer sees five directories it does not have; every zone
  shows its file count and purpose; the header names the archetype and its
  description. A layout directory the archetype does not declare is still listed
  when it holds files, so nothing with content becomes invisible.
- **`assay check --advisories`**: placement reminders, described below.

Directories that are not places to put work are left out of all three: anything
under `.assay/`, and `<zone>/templates` folders holding blank forms for their
parent.

## `assay status --json`

The most-run command now has machine-readable output. `--json` emits the full
status structure: zones with their paths, file counts, and purposes; the
archetype and its description; systems, living sources, donors, and counts.

## Solve Workspaces No Longer Ship `runs.jsonl`

The template shipped an empty file that nothing filled: across existing
workspaces the observed fill rate for template-created `runs.jsonl` was zero,
and every non-empty one was written by a project's own harness.

- `solve` no longer creates `runs.jsonl`. There is no new command to write one.
- The append convention is documented in the solve `README.md` instead: one JSON
  object per line at the workspace root, with `run_id`, `started_at`,
  `benchmark`, `attempt`, `score`, `params`, `artifact`, and `notes` as
  suggested fields. An evaluator or judge script needs one appended line.
- `assay status` reports `Run records (runs.jsonl): <n>` once the file exists,
  so an existing log stays visible and a workspace that has one keeps its count.

Existing workspaces keep their `runs.jsonl`; nothing deletes it.

## New Advisories

All appear only under `assay check --advisories` and never fail the check.

- A top-level directory the archetype does not declare. Writing straight into a
  directory instead of going through a command is normal usage, so this makes
  misplaced material visible and fixable rather than turning it into an error.
- A file under `analyses/references/` with no `Status:` header, which is a
  hand-written note that never entered the analysis lifecycle.
- An `AGENTS.md` managed block whose directory table no longer matches the
  current archetype, with the `assay update --agents` command to refresh it.
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

### Removed

- The `solve` archetype's `runs.jsonl` template. Existing files are untouched
  and `assay status` still counts them; new solve workspaces do not get one.
- The `solve.runs.jsonl` template id, which nothing else referenced.

No command or flag was removed. `Archetype.dirs` (and the learning/absorption
variants) now hold `{ path, purpose }` objects rather than strings; embedders
reading them directly should use `dirsForArchetype()` for paths or
`archetypeDirectories()` for both. Existing workspaces need no action to keep
working; `intent` does nothing until it is explicitly enabled.
