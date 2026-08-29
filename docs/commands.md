# Commands

Assay 0.15 is a thin stitching layer. The study commands come from
[`absorb-anything`](https://github.com/NB-Corp/absorb-anything), the build
commands from [`own-work`](https://github.com/NB-Corp/own-work), and the suite
owns the lifecycle commands both halves would otherwise answer differently.

Every command discovers the workspace envelope and accepts only the exact
`0.14.0+s4+l8` on-disk format. The physical envelope is `.assay/` for a
workspace assay created and `.absorb/` for one absorb created; whichever is
present is read and written in place.

## Suite lifecycle — owned by assay

```text
assay init [target] [--name <project>] [--overlay] [--git] [--no-agents]
           [--template study|solve|explore|<file.yaml>] [--json]
assay check [--root <dir>] [--advisories] [--json]
assay status [alias] [--root <dir>] [--json]
assay prime [--root <dir>] [--json]
assay explain <topic> [--json]
```

`init` defaults to **standalone** mode with the `.assay/` envelope, which is the
shape assay has always written. `--overlay` keeps every work folder inside the
envelope instead. An existing envelope is reused and filled in — the study half
may already own it, and init never re-scaffolds or replaces its records. On a
fresh workspace init runs the common scaffold once and then completes the build
workspace; on an existing one it only completes what is missing.

`check` runs the full common envelope check, the study records, and the build
records. Rows the two halves both report appear once, and the command exits 1 if
either half fails. `status` merges one payload: the shared workspace, the study
summary (sources, broken references, knowledge), and the build counts (tasks,
roadmaps, specs, systems). With a Source alias it reports that Source instead.

`prime` and `explain` read one merged object table of nine topics:
`workspace`, `project`, `source`, `analysis`, `knowledge`, `task`, `roadmap`,
`spec`, `system`. Study topics carry the study half's text, build topics the
build half's, and the two shared topics — `workspace` and `project` — carry the
suite's own, because each half describes them from its own view only.

## Study surface — mounted from absorb-anything

```text
assay add <repo-or-dir> [alias] [--branch <branch>]
assay link <target-workspace-or-source> [target-source] [--alias <local>]
assay home <alias>
assay unlink <alias>
assay capture <alias> [--note <text>]
assay import <alias> <dir-or-archive> [--note <text>]
assay sync [alias] [--branch <branch>] [--ref <ref>] [--class <change-class>]
assay switch <alias> <branch-or-ref> [--sync]
assay log <alias>
assay diff <alias> [--since <observation>]
assay analysis new|close ...
assay knowledge add <pattern|guide|troubleshooting> <title> [--from-analysis <path>]
assay update [--root <dir>] [--dry-run] [--agents] [--force | --create-new]
```

A Source's shape follows what the material is, not a flag: a Git repository or
URL is checkout-backed and `sync`/`switch` move it, while a plain directory or
archive is copied in once and `import` replaces that content. Either kind can be
captured at any time. If another workspace already holds the material, `link`
points at that one home instead of copying its identity.

`update` changes only the fixed core assets recorded in the managed receipt,
plus an existing or explicitly requested managed block in `AGENTS.md`.

## Build surface — mounted from own-work

```text
assay task ...
assay roadmap ...
assay spec ...
assay system register|update|promote|archive|list|show ...
```

Task, Roadmap, Spec, and System authority stay independent of each other:
finishing a Task accepts nothing above it, activating a Spec validates structure
rather than agreement, and `system archive --apply` is a registry transition
that never moves System bytes.

## Not mounted

`migrate-envelope` is deliberately absent. It renames a legacy envelope to
`.absorb`, and `.assay` is assay's native envelope — a suite command that
renames its own envelope away would be self-defeating. The escape hatch stays
with the half that prefers the other name:

```text
absorb migrate-envelope --root <dir>     # rename .assay -> .absorb
ownwork migrate-envelope --root <dir>    # same operation from the build half
```

After the rename every tool keeps working, assay included: envelope resolution
prefers `.absorb` wherever it is present.

## Deferred in 0.15

`adopt`, `attach`, `convert`, `template`, `workspace` (the machine-global
workspace index), `source adoption`, `upstream`, and `plugin` are not part of
0.15. They were built against APIs the 0.14 monolith owned. A workspace that
needs those flows stays on 0.14, which the `v0.14.0` tag preserves. See
[releases/NEXT.md](../releases/NEXT.md).
