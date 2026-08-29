# assay

**One CLI over both halves of the suite.**

Assay 0.15 is a thin stitching layer. The study half is
[`absorb-anything`](https://github.com/NB-Corp/absorb-anything) — sources,
analyses, knowledge. The build half is
[`own-work`](https://github.com/NB-Corp/own-work) — tasks, roadmaps, specs,
systems. Assay mounts both command surfaces on one binary and owns the
suite-level lifecycle: `init`, `check`, `status`, `prime`, `explain`.

```bash
assay init                                          # one .assay/ workspace, both halves ready
assay add ./reference-project upstream               # study: external material with a lineage
assay task create --title "Port the scheduler"       # build: one durable outcome
assay check                                          # both halves, one exit code
```

> Status: 0.15.0. The two halves are not on npm yet, so build from source with
> the steps below.

## Install from source

Requires Node >= 22.13 and pnpm 11. Clone the three repositories next to each
other; the workspace resolves the halves from the sibling checkouts:

```bash
git clone https://github.com/NB-Corp/absorb-anything
git clone https://github.com/NB-Corp/own-work
git clone https://github.com/X-T-E-R/assay
cd absorb-anything && pnpm install && pnpm build && cd ..
cd own-work && pnpm install && pnpm build && cd ..
cd assay && pnpm install && pnpm build
```

The CLI is then at `packages/assay/dist/cli.js`.

```bash
alias assay="node $PWD/packages/assay/dist/cli.js"
```

## The envelope

`assay init` creates a **standalone** workspace whose physical envelope is
`.assay/`, which is what assay has always written. Both halves read that
envelope in place — no migration, no rename:

```text
.assay/                # manifest, managed receipt, systems registry, events
sources/ analyses/ knowledge/    # study material, at the workspace root
tasks/ project/                  # build objects, at the workspace root
```

`assay init --overlay` keeps every work folder inside `.assay/` instead, for a
repository that already owns its root.

Absorb prefers `.absorb/` and wins wherever it is present, so a workspace
absorb created is also fully usable from `assay`. The suite deliberately mounts
no `migrate-envelope` command — renaming assay's own envelope belongs to the
half that prefers the other name (`absorb migrate-envelope`).

## Command surface

| Owner | Commands |
| --- | --- |
| assay | `init` `check` `status` `prime` `explain` |
| study half | `add` `link` `home` `unlink` `capture` `import` `sync` `switch` `log` `diff` `analysis` `knowledge` `update` |
| build half | `task` `roadmap` `spec` `system` |

`assay check` runs the shared envelope check, the study records, and the build
records, reporting each row once and failing if either half fails. `assay
prime` and `assay explain` cover all nine objects: `workspace`, `project`,
`source`, `analysis`, `knowledge`, `task`, `roadmap`, `spec`, `system`.

## License

MIT.
