# Unreleased

Unreleased changes after Assay 0.14.0 are recorded below.

Assay becomes a thin stitching layer. The evidence half moved to
[`absorb-anything`](https://github.com/NB-Corp/absorb-anything) and the delivery
half to [`own-work`](https://github.com/NB-Corp/own-work); this repository now
ships one package that depends on both and adds the suite lifecycle, the merged
object table, and the mount that puts everything under one binary. The on-disk
format does not change: a 0.14.0 workspace is a 0.15.0 workspace, and one
workspace serves `assay`, `absorb`, and `ownwork` interchangeably.

## Breaking

- The `assay-core` and `assay-cli` packages are gone, along with
  `assay-plugin-fixture`, `assay-plugin-ponytail`, and `assay-test-support`. The
  distributable is a single `assay` package with the `assay` binary. Code that
  imported `assay-core` should import `absorb-anything-core` (envelope, manifest,
  layout, managed receipt, Source, Analysis, Knowledge) or `own-work` (Task,
  Roadmap, Spec, System) directly; both are the same operations under their new
  owners.
- `assay adopt`, `assay attach`, `assay convert`, `assay template`, `assay
  workspace`, `assay source adoption`, `assay upstream`, and `assay plugin` are
  not in 0.15. They were built against monolith-only APIs and are not ported.
  A workspace that needs those flows stays on 0.14.0, preserved by the `v0.14.0`
  tag. `--template` is still accepted by `init` and still expands exactly once;
  only the inspection subcommands are gone.
- `assay migrate-envelope` is not mounted. `.assay` is assay's native envelope,
  so the suite does not offer a command that renames it away. `absorb
  migrate-envelope` and `ownwork migrate-envelope` still perform the rename, and
  assay keeps working on the result.
- Source commands are top-level, following the study half: `assay add`, `assay
  capture`, `assay import`, `assay sync`, `assay switch`, `assay log`, `assay
  diff`, `assay link`, `assay home`, `assay unlink`. The `assay source ...`
  prefix is gone.

## Added

- `assay prime` and `assay explain` read one merged table of nine topics:
  `workspace`, `project`, `source`, `analysis`, `knowledge`, `task`, `roadmap`,
  `spec`, `system`. Study topics carry the study half's text and build topics the
  build half's, with command examples retargeted to `assay`. The two topics both
  halves define — `workspace` and `project` — carry suite text, because each half
  describes them from its own side only.
- `assay init --overlay` selects the study half's default layout. Standalone
  remains assay's default.
- `absorb-anything-core`'s `initFramework` accepts an `envelope` option, which is
  how a suite init writes `.assay/` while sharing one implementation with
  `absorb`. Envelope resolution already preferred an existing `.absorb`, so both
  names are readable by every tool.

## Changed

- `assay init` reuses an existing envelope instead of scaffolding over it. On a
  workspace either half already created, it completes what is missing and leaves
  every existing record untouched.
- `assay check` runs both halves and reports rows they share once. It exits 1 if
  either half fails.
- `assay status` merges one payload: the shared workspace, the study summary
  (sources, broken references, knowledge), and the build counts (tasks, roadmaps,
  specs, systems). `assay status <alias>` still reports a single Source.
- The workspace envelope stays `0.14.0+s4+l8`. There is no migration step in this
  release.

## Fixed

- None.

## Removed

- The monolith's own implementations of every object, now owned by the halves.
  Behaviour is unchanged; the code has one home instead of two.
