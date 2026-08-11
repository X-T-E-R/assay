<div align="center">
  <img src="docs/assets/hero.svg" alt="Assay — raw material in, refined knowledge out" width="880" />

  <h1>Assay</h1>

  <p><em>assay /əˈseɪ/, v. — to analyze an ore and determine what it is made of.</em></p>

  <h3>Study many. Build your own.</h3>

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

Assay is a command-line workbench for people who build by studying:

- **Study many.** Capture frameworks, libraries, patterns, and ideas as observed Sources, work them through recorded Analyses, and close every evaluation with an explicit adopt / reject / defer decision plus its evidence. Months later you can still answer *what did we take, why, and does it still hold?*
- **Build your own.** Promote what proves out into your own registered Systems and Knowledge, and keep the work moving with Tasks, Roadmaps, and Specs whose stable identities survive sessions, agent switches, and context compaction.

## How it works

```text
sources/   →   analyses/   →   systems/  +  knowledge/
 observe        interpret       build         remember
```

Assay keeps that loop under your version control. The discipline is small but strict: every fact has exactly one authority, every adoption of outside material keeps its evidence, and every decision is recorded instead of remembered.

## Where it shines

Assay is a general workbench, but three scenarios get the most out of it:

- **Evaluating and adopting external frameworks.** Add a repo as a living or frozen Source, review it in an Analysis, and record an `adopt` / `reject` / `experiment` exit. Source-adoption receipts then tie the material you carried into your systems to evidence and accept/reject/defer decisions — so next year's you knows exactly what came from where, and why.
- **Long-running projects with AI assistants.** Tasks keep stable ids, reader-owned PRDs, and handoff checkpoints; Roadmaps and Specs hold direction and acceptance. All of it survives sessions, agent switches, and context compaction.
- **Evidence-driven exploration of any kind.** One-shot Templates scaffold the loop for different work: `study` (evaluate external systems), `solve` (objectives, attempts, benchmarks), `explore` (parallel approaches and trials). Custom Templates are plain YAML.

## Principles

The workflow is packaged; the ideas travel anywhere:

- **One fact, one authority.** Assay never guesses a "current" task from titles or counts, and never maintains two copies of the same truth.
- **Evidence before opinion.** A copied folder is not an evaluated one; an Analysis is not closed without an explicit exit.
- **Advisory, not a gate.** Assay records facts and decisions, then gets out of the way. It blocks only to prevent data loss or corruption — never to enforce ceremony.
- **Assistant-agnostic core.** The artifact model stands alone; the managed `AGENTS.md` block and the bundled `assay-builder` skill are adapters, so the workbench outlives any single assistant.
- **Files over services.** Git-friendly and inspectable with the tools you already have — nothing holds your data hostage.

## Quick start

Requires Node.js >=22.13.0 and the repository-pinned pnpm 11.3.0.

```bash
git clone https://github.com/X-T-E-R/assay.git
cd assay
pnpm install && pnpm build

# Create a workbench
node packages/assay-cli/dist/cli.js init ../my-study --name MyStudy --template study
node packages/assay-cli/dist/cli.js status --root ../my-study
node packages/assay-cli/dist/cli.js check  --root ../my-study
```

Throughout the docs, `assay` refers to this built CLI (the package exposes the `assay` bin). To drive it from an AI assistant, run `node scripts/install.mjs` — it builds the repo and links the bundled `assay-builder` skill into your skills directory.

A typical session:

```bash
assay source add https://github.com/some/framework --mode frozen
assay analysis new "Framework review" --for-source framework
assay analysis close analyses/<file>.md --exit adopt --note "Pattern X is worth reusing"
assay knowledge add pattern "Pattern X" --from-analysis analyses/<file>.md
assay task create --title "Port pattern X" --description "Bounded outcome with acceptance criteria"
```

## What's inside

| Object | What it gives you |
| --- | --- |
| **Project** | A single id/name authority that owns roadmap and acceptance. |
| **Task** | Durable bounded outcomes (`task-0001-<slug>`) with reader-owned `prd.md`, handoff checkpoints, typed lineage, and explicit host-context bindings. |
| **Roadmap** | Project outcomes with separate state (`candidate` → `committed` → `realized`) and horizon (`now` / `next` / `later`), linked to Tasks without lifecycle coupling. |
| **Spec** | A closed machine envelope plus reader-owned prose; explicit promotion from an Analysis or Task with recorded provenance. |
| **Source** | Living or frozen external material with an immutable observation ledger, drift reporting, and checkout data-loss protection. |
| **Source adoption** | Traceable carry-over of upstream material into your systems, with evidence records and accept / reject / defer decisions. |
| **Analysis / Knowledge** | Interpretation with explicit decision exits, and promoted conclusions kept out of the inbox. |
| **System** | A registry of independently versioned systems (own Git repos welcome) with primary/superseded lineage. |

## Two layouts, one model

- **Standalone** — Assay state under `.assay/`, work areas at the workspace root.
- **Overlay** — everything under `.assay/` inside an existing product repository; the product root stays the primary System.

```bash
assay attach --root ../product --name Product --template study --privacy private
assay convert --root ../product --to standalone --target ../product-workbench --copy
```

Assay never touches global state unless you opt in to the explicit workspace index (`assay workspace track|discover|list|forget`).

## Workspace contract

Assay 0.13 accepts exactly the `0.13.0+s4+l8+r3` envelope and fails closed on older or malformed workspaces. Compatible upgrades run through the native `assay update` path, which only touches framework-owned files recorded in the managed receipt. When Assay reports an `assay-cutover:<observed>-><required>` locator, follow [Major workspace cutovers](docs/legacy-cutover.md).

## Documentation

- [Commands](docs/commands.md) — full CLI surface and authority boundaries
- [Workspace layout](docs/workspace-layout.md) · [Layout modes](docs/layout-modes.md)
- [Task](docs/task.md) · [Roadmap](docs/roadmap.md) · [Spec](docs/spec.md)
- [Source adoption](docs/source-adoption.md) — relationships, evidence, decisions
- [Design principles](docs/background/design-principles.md) — why Assay works this way
- [examples/framework-template](examples/README.md) — a sanitized generated workspace

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run the full check before committing:

```bash
pnpm check
```

## License

[MIT](LICENSE) © Assay contributors
