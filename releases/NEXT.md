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
- Captures are append-only. Identical text captured again is a no-op, and
  `--source` or `--supersedes` passed to that repeat call are named as ignored
  rather than silently dropped. The same text against a different system, or
  with a different shadow marking, is refused instead of resolving to the first
  record. `--supersedes` takes recorded capture ids and refuses the ones it
  cannot find. Text whose record was edited after it was written is refused,
  naming the recorded and the current digest; corrections are recorded as a new
  capture with `--supersedes <capture-id>`.
- A damaged record is reported, not fatal: `intent list` marks it
  `[modified after recording]` or `[unreadable record]` — `integrity` in
  `--json` — and lists every other capture normally. Capturing and promoting
  still refuse to touch it.
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
The systems registry is the machine-readable home and the only place every
command reads it from. Absent means `inline`.

A system's sidecar contract carries the field only when `register` generates the
contract, so a later `system update` changes the registry without rewriting the
contract, and the root contract an overlay workspace gets from `assay attach`
does not carry it at all. Read the registry — `assay system show <name>` — when
the two could disagree.

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

## Upstream Drift Is Reported by `status`

Adding a living source was popular; syncing one almost never happened. The
answer a source exists to provide — did it move, and does that reach anything
we adopted from it — is now part of the command that gets run anyway.

```text
Upstream
  - qwen-agent   3 new upstream commits   affects 2 donor mappings
  - langgraph    local checkout modified (1 uncommitted file); not recorded — preserve or discard it before the next sync
  - autogen      no change
Next: assay source sync qwen-agent
```

- **Local, always on, no network.** Each Git-backed checkout's `HEAD` and
  working tree are compared against the commit its latest observation recorded.
  A hand-edited managed checkout becomes visible here for the first time:
  previously only `source sync` noticed, by refusing to run.
- **A checkout that is not a Git repository reports `not checked (no cheap
  signal)`** instead of being content-hashed. Full fingerprint comparison stays
  in `sync`, where that cost is already being paid.
- **`assay status --fetch` adds the remote comparison.** It is never implicit.
  Offline, expired credentials, or a deleted remote annotate that one source
  with `upstream not checked this run` and leave the exit code at 0.
- **Donor impact.** Changed paths are intersected with the source locators of
  the workspace's donor adoptions, so a moved source says how many adopted
  mappings it reaches. `donor inspect` remains the explicit verb for writing an
  immutable inspection record; you no longer have to run it to learn that
  something changed.
- **`Next:`** names a command only for an upstream move, which is the case
  `source sync` resolves. A drifted or dirty checkout is reported instead,
  because `sync` deliberately refuses those.
- All of it is in `assay status --json` under `upstream`.

## Change Grading Suggests a Decision Record

A source graded `major` or `replacement` now prompts for an ADR — in the `source
sync` output that produced the grade, and in `status` for as long as it is the
source's latest change. Deciding whether a change deserves a decision record is
the step people report as the hard one; the grade already existed and nothing
consumed it. It is advisory text and blocks nothing.

## `assay donor take`

Registering an adoption no longer requires writing a definition file first:

```bash
assay donor take readseek:packages/pi-readseek/src/hashline.ts \
  --into pipi:packages/pipi-readseek/src/anchor.ts --mode adapt
```

- Synthesizes and registers the single-source, single-target definition
  `--file` would have contained, with the same schema and validation. The result
  is an ordinary adoption that `donor show`, `donor inspect`, `donor decide`,
  and the `Upstream` section all read.
- Both arguments are `<name>:<path>`, split at the **first** colon, with paths
  relative to the source observation and to the registered system. A
  drive-prefixed or absolute path is refused by name rather than split
  somewhere else.
- The locator shape is read off the observation: a path naming one recorded file
  becomes `exact`, a path with files beneath it becomes `prefix`.
- `--mode adapt|copy` records how the material was carried over. `--id`,
  `--title`, and `--to <observation>` override the defaults.
- `donor register --file` is unchanged and remains the way to declare several
  mappings, several targets, or required evidence.

## The Frozen-Reference `analyzed` Gate Is Gone

`analyzed: false` was written into every `reference.yaml` and flipped by
`analysis close`. It gated nothing, and across existing workspaces it was false
everywhere.

- `reference add` and `absorb` no longer write the field, `analysis close` no
  longer rewrites the case file, and the `reference.frozen` event drops
  `analyzed` / `analysis_required`.
- The "frozen reference with no analysis citing it" advisory is removed with it.
- Case files that still carry `analyzed` keep loading; the field is ignored.
- What replaces it is a gap that is actually checkable: **a frozen directory
  with no `reference.yaml` at all**, which is how references frozen by hand or
  by older builds carry no provenance. `check --advisories` reports each one
  with the command that fixes it, and `assay reference backfill <path>
  [--source <origin>]` writes the missing case file. Existing provenance is
  never overwritten.

## New Advisories

All appear only under `assay check --advisories` and never fail the check.

- A frozen reference directory with no `reference.yaml`, with the
  `assay reference backfill` command that writes one.
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

## Three Built-In Archetypes Instead of Six

`science`, `evaluation`, and `library` are gone. They shipped alongside `solve`,
had the same exposure, and finished it with no workspaces at all while `solve`
picked up twelve.

- The built-ins are now `study`, `solve`, and `explore`.
- `--archetype science` fails with a message that names the removal and what to
  use instead, so a line copied out of an old document does not read as a typo:

  ```text
  archetype 'science' was removed in Assay 0.4.0 (use `study` for evidence work,
  or declare a custom archetype). Available archetypes: explore (built-in),
  solve (built-in), study (built-in)
  ```
- **Migration:** there is nothing to migrate — no workspace used any of the
  three. A workspace whose manifest still records one keeps working: `check` and
  `status` report the base structure and say in one line why the archetype's own
  directories are absent from the report. To keep one of these shapes, copy its
  directories into your own archetype YAML under `.assay/archetypes/` or
  `~/.assay/archetypes/`; the loader has always preferred your file over a
  built-in of the same name.
- The `science.*` and `evaluation.*` template ids are gone with them. Nothing
  else referenced them.

## `research` Loads as `study`

Renaming `research` to `study` left six workspaces recording a name this build
could not resolve, which quietly downgraded `check` and `update` to a base-only
pass.

- The loader resolves `research` to `study`, so those manifests work as they
  did before the rename. An archetype file you provide under the old name still
  wins over the alias.
- `assay update` rewrites the manifest to `study` while it is there, and reports
  it. Nobody has to run a migration command.
- When an archetype genuinely cannot be resolved, `status` and `check` now say
  so in one line — `... — reporting base structure only` — instead of silently
  reporting a shorter workspace. The `check` row is a warning and does not fail
  the workspace.

## `Next:` on the Commands People Actually Run

Every write command with real adoption now ends by naming the command that
continues the loop: `source add`, `analysis new`, `analysis close`,
`iteration start`, `iteration close`, `system register`, `knowledge add`, and
`capability add`. The hint is specific to what just happened — closing an
analysis with `--exit adopt` points at `knowledge add`, with `--exit adr` at
`adr new`.

`source add` points at `assay status`, which reports upstream movement on its
own, rather than at a `source sync` that has to be remembered.

## `projects prune` No Longer Forgets Live Workspaces

`prune` removed every record it could not load a manifest for, which included
workspaces that are still on disk — every unmigrated `.framework/` workspace,
and any workspace with a damaged manifest.

- `prune` now removes a `missing` record only when the directory it points at is
  gone. A directory that still exists stays in the registry, listed as missing,
  where it can still be repaired or migrated. `uninstalled` records are removed
  as before, since that status is an explicit statement.
- The registry also reads the legacy `.framework/manifest.json`, so a v3
  workspace is listed as active rather than missing.

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
- The frozen-reference `analyzed` flag: no longer written by `reference add` or
  `absorb`, no longer set by `analysis close`, and no longer read by anything.
  Existing case files keep loading with the field present. The advisory that
  depended on it — a frozen reference no analysis cites — is gone; a frozen
  directory missing `reference.yaml` is reported instead.
- The `analyzed` and `analysis_required` keys in the `reference.frozen` event,
  and `marked_reference_analyzed` in the `analysis.closed` event.
- The `science`, `evaluation`, and `library` built-in archetypes, their YAML
  files, and the `science.*` and `evaluation.*` template ids. No workspace used
  any of the three; requesting one by name now fails with a message naming the
  removal.

No command or flag was removed; `status --fetch`, `donor take`, and
`reference backfill` were added. `Archetype.dirs` (and the learning/absorption
variants) now hold `{ path, purpose }` objects rather than strings; embedders
reading them directly should use `dirsForArchetype()` for paths or
`archetypeDirectories()` for both. `getFrameworkStatus()` takes its own options
type with an optional `fetch` and can return an `archetypeNotice`. Existing
workspaces need no action to keep working; `intent` does nothing until it is
explicitly enabled.
