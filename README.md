<div align="center">
  <img src="docs/assets/hero.svg" alt="Assay — raw material in, refined knowledge out" width="880" />

  <h1>Assay</h1>

  <p><em>assay /əˈseɪ/, v. — to analyze an ore and determine what it is made of.</em></p>

  <h3>Absorb anything. Build your own.</h3>

  <p>
    <a href="https://github.com/X-T-E-R/assay/actions/workflows/ci.yml"><img src="https://github.com/X-T-E-R/assay/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen" alt="Node.js >=22.13" /></a>
  </p>

  <p>
    <a href="https://x-t-e-r.github.io/assay/">Website</a> ·
    <a href="#quick-start">Quick Start</a> ·
    <a href="docs/README.md">Docs</a> ·
    <a href="CONTRIBUTING.md">Contributing</a> ·
    <a href="README.zh.md">中文</a>
  </p>
</div>

Assay is one command-line workbench made of two halves:

- **[absorb-anything](https://github.com/NB-Corp/absorb-anything)** is the study half. Whatever you're absorbing — a codebase, a library, a paper's companion repo — gets a home where checkouts, observations, analyses, and distilled knowledge accumulate instead of evaporating.
- **[own-work](https://github.com/NB-Corp/own-work)** is the build half. Tasks, roadmaps, specs, and registered systems with stable identities that survive sessions, agent switches, and context compaction.

Each half is its own product and works alone. Assay stitches them into a single `assay` binary over one workspace, for people who want the whole loop — *study it, decide on it, build your own* — in one place.

## How it works

```text
sources/   →   analyses/   →   systems/  +  knowledge/  +  tasks/
 observe        interpret       build         remember      keep moving
```

Assay keeps that loop under your version control. The discipline is small but strict: every fact has exactly one authority, every decision is recorded instead of remembered, and everything is a plain file in a `.assay/` workspace your repo owns.

## Quick start

Requires Node.js >=22.13.0.

```bash
npm install -g @nb-corp/assay    # scoped name; the binary is plain `assay`

# Create a workbench (standalone by default; --overlay to nest in an existing repo)
assay init my-study --name MyStudy
```

To hack on it instead, clone the three repositories side by side (`NB-Corp/absorb-anything`, `NB-Corp/own-work`, `X-T-E-R/assay`), then `pnpm install && pnpm build` in `assay`. A typical session, all in one binary:

```bash
assay add https://github.com/some/framework                 # study half: give it a home
assay analysis new "Framework review" --for-source framework
assay analysis close analyses/<file>.md --exit adopt --note "Pattern X is worth reusing"
assay knowledge add pattern "Pattern X"
assay task create --title "Port pattern X" --priority P1    # build half: keep the work moving
assay status                                                # one merged view of both halves
```

Start an AI session with `assay prime` — one screen that explains every object in the workspace, both halves included.

## The workspace

`assay init` creates a **standalone** workbench: state under `.assay/`, work areas at the root. `assay init --overlay` nests everything under `.assay/` inside an existing repository instead.

The on-disk format is exactly the one the two halves speak. That means `absorb` and `ownwork` operate on an Assay workspace in place — and Assay operates on theirs. One workspace, three interchangeable tools, no migration between them.

## What's inside

| Object | What it gives you | Half |
| --- | --- | --- |
| **Project** | A single id/name authority for the workspace. | shared |
| **Source** | External material with an append-only observation ledger, drift reporting, and byte captures when a decision needs them. | study |
| **Analysis / Knowledge** | Interpretation with explicit decision exits, and promoted conclusions kept out of the inbox. | study |
| **Task** | Durable bounded outcomes (`task-0001-<slug>`) with reader-owned `prd.md` and handoff checkpoints. | build |
| **Roadmap** | Project outcomes with separate state and horizon, linked to Tasks without lifecycle coupling. | build |
| **Spec** | A closed machine envelope plus reader-owned prose, promoted with recorded provenance. | build |
| **System** | A registry of independently versioned systems with primary/superseded lineage. | build |

## Assay 0.15 is a rebase, not a port

0.15 replaced the monolithic implementation with a thin layer over the two component packages. Most of the 0.14 surface came through unchanged; the notable differences:

- Source commands live at the top level (`assay add`, not `assay source add`).
- `init` reuses an existing workspace instead of refusing it, and standalone is the default.
- Source adoption, upstream reach, templates beyond init, plugins, and the workspace index (`attach` / `convert` / `workspace ...`) are **deferred** — they need those workflows re-homed onto the new core. If you rely on them today, stay on [v0.14.0](https://github.com/X-T-E-R/assay/releases/tag/v0.14.0); the 0.15 CLI reads and writes 0.14 workspaces in place either way.

The full ledger is in [releases/NEXT.md](releases/NEXT.md).

## Which tool should I install?

- Just studying external material, or want the lightest possible footprint in an existing repo? **absorb-anything** (`.absorb/` envelope, overlay by default).
- Just tracking tasks, roadmaps, and specs? **own-work**.
- Want both halves in one binary, or you already have `.assay/` workspaces? **Assay.**

They share one on-disk contract, so this choice is reversible at any time.

## Documentation

- [Commands](docs/commands.md) — the merged CLI surface and authority boundaries
- [Workspace layout](docs/workspace-layout.md) · [Layout modes](docs/layout-modes.md)
- [Source reference](docs/source-reference.md) — clone once, reference everywhere
- [Design principles](docs/background/design-principles.md) — why Assay works this way
- [examples/framework-template](examples/README.md) — a sanitized generated workspace

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run the full check before committing:

```bash
pnpm check
```

## License

[MIT](LICENSE) © Assay contributors
