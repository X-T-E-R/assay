# Assay

**Study many. Grow your own.**

Assay turns sources, experiments, and AI-assisted research into decisions your repo can remember.

Run it as a standalone workbench, or attach it privately to the repo you already ship.

> 中文版: [README.zh.md](README.zh.md)

## What Assay does

Your agent can inspect twenty repositories in an afternoon. Without a workbench, the useful parts disappear into chat scrollback: what mattered, what failed, what was adopted, and why the next agent should not start over.

Assay is a CLI workbench for turning evidence into better systems. It keeps sources, experiments, analyses, ADRs, and reusable knowledge in plain files so decisions survive context resets.

The loop is simple:

```text
sources / experiments / goals
        -> structured analysis + checks
        -> adopt / reject / experiment / ADR
        -> knowledge, systems, and the next iteration
```

It is not a notes app, not an agent runtime, and not a prompt collection. It is the place where "this project does something interesting" becomes "we copied this pattern, rejected that claim, and can explain the decision later."

## Choose how to start

Assay fits the way your code already lives.

| Mode | Use it when | Where Assay writes | Git posture |
| --- | --- | --- | --- |
| `standalone` | You want a dedicated study / solve / explore workspace. | `.assay/` for Assay state, with work folders such as `references/`, `analyses/`, `iterations/`, `knowledge/`, and `systems/` at the workspace root. | Optional workbench Git. Independent systems keep their own Git. |
| `overlay` | You already have a product repo and want its root to be the primary system. | One private `.assay/` folder containing Assay state and work folders. Product files stay where they are. | Product Git ignores `.assay/` by default; Assay state can optionally have its own Git inside `.assay/`. |

## Choose what you're building

Archetypes shape the workspace structure and defaults. They are **structure + conventions + common verbs**, not separate command families.

| If you want to... | Start with | Assay gives you |
| --- | --- | --- |
| Study external projects without losing provenance | `study` | living sources, reference analyses, pattern notes, decision exits |
| Work toward a measurable target | `solve` | objectives, intake, attempts, benchmarks, iterations |
| Explore several possible directions | `explore` | approaches, trials, comparison notes, iteration paths |

The three built-ins cover the three shapes work actually takes: study outside examples, solve a measurable target, or explore when the target shape is still open. A workspace that needs a different structure declares its own archetype YAML under `.assay/archetypes/` or `~/.assay/archetypes/`; see `docs/workspace-layout.md`. The command surface stays small: `source`, `analysis`, `donor`, `intent`, `iteration`, `adr`, `knowledge`, `system`, and `check`.

## Turn capabilities on when you need them

Capability modules are optional features. An archetype enables some at init; the rest can be added to a live workspace at any time, so the choice you made on day one never locks you out.

| Module | Turns on | Enable it with |
| --- | --- | --- |
| `adr` | Numbered architecture decisions with status and supersede chains | `assay capability add adr` |
| `intent` | Verbatim capture of what was asked for, promoted into requirements or ADRs | `assay plugin add assay.intent` |
| `iteration` | Planned changes to your own systems, opened and closed with a result | `assay capability add iteration` |

`assay capability list` shows which modules a workspace has and how it got them. Adding a module scaffolds its directories and templates, records it in the manifest, and is safe to re-run. `assay capability add intent` remains a compatible legacy entrance; `assay reconcile --apply` adopts its existing files into the plugin receipt without moving or rewriting intent records.

Intent is the newest of the three, and the one most often missing from a repo: months later the code is still there but the reason for it is not. `assay intent capture` stores the original wording, content-addressed and append-only, scoped to a registered system, so a requirement or an ADR can point back at the words it came from.

## Add workspace plugins without another setup lifecycle

Plugins extend an existing Assay workspace; they do not replace `init`,
`attach`, or the evidence workbench itself. `assay.intent` contributes the
additive `intent` capability. `assay.trellis` is an in-package operational
plugin with protocol and workspace-state schema version 1. Its dynamic state
lives under `.assay/trellis/`; native Assay ADR and intent workflows remain active.

```bash
# Create or attach, then install intent in the same command.
assay init ../product-assay --name Product --plugin assay.intent
assay attach --name Product --plugin assay.intent

# Or add it later.
assay plugin add assay.intent
assay plugin add assay.trellis
assay plugin list
assay plugin check
```

The manifest records desired plugins. `.assay/plugins.json` records what this
workspace has actually installed. `assay reconcile` compares those two layers
with the existing files and prints a plan; it is a dry-run unless `--apply` is
given. Reconcile only converges plugins in a workspace that already has an
Assay manifest. It never creates or attaches a workspace, overwrites existing
intent files, or removes an orphaned plugin receipt.

Adding `assay.trellis` creates only its missing `.assay/trellis/` runtime state
and installation receipt. It does not invoke a Trellis CLI or depend on a root
`.trellis/` sidecar. Operational v1 includes task/session/journal/config,
durable channels and external-worker leases, bounded read-only Codex memory,
legacy migration, and `protocol --json`, in addition to `context --host codex`.
External workers invoke the CLI; Assay does not pretend to spawn a provider.
Optional session ids fail closed when an unscoped lookup is ambiguous.

## Quick start

Build and link the CLI from this repository:

```bash
git clone https://github.com/X-T-E-R/assay.git
cd assay
pnpm install
pnpm build
cd packages/assay-cli && npm link && cd ../..
```

Create a standalone study workspace:

```bash
assay init ../assay-study --name AssayStudy --archetype study --no-track
cd ../assay-study
assay check
assay source add https://github.com/<owner>/<project> sample
assay analysis new "Review sample" --for-source sample
assay event capture --kind decision --text "Adopt hero + before/after; reject unsupported benchmark claims"
assay check
```

Attach Assay privately to a repo whose root is the primary system:

```bash
cd /path/to/existing-repo
assay attach --name ExistingRepo --archetype study --privacy private
assay check
```

In overlay mode the product repo stays the product repo. Assay registers the repo root as the primary system and keeps its own work under `.assay/`. Product Git ignores `.assay/`, so `git status` stays clean.

`assay check` defaults to workspace structure and persisted-record integrity.
Use `assay check --advisories` when you also want reminders about open
iterations, unfinished drafts, pending queues, adoption archives, or major
source changes. Those reminders are optional and never turn ordinary workflow
state into a failing check.

If you later want to separate the overlay into a standalone workbench, detach it without moving your product repo:

```bash
assay convert --to standalone --target ../existing-repo-assay
```

## Use it with an agent

The repo ships an agent-facing Skill at `skills/assay-builder`. It calls this clone's CLI directly, so keep the cloned repo in place after installing:

```bash
git clone https://github.com/X-T-E-R/assay.git assay
cd assay
node scripts/install.mjs
```

Then ask your agent to use the Assay Builder skill when a task needs source study, evidence capture, ADRs, iterations, or reusable knowledge. The useful mental model is simple: do not just "look at examples"; open a source, analyze it, close the decision, and promote durable findings.

See `skills/assay-builder/references/cli-setup.md` for setup flags and invocation details.

## Git model

Assay separates system code from Assay memory.

In `standalone` mode, the workspace Git is optional. Use it when analyses, ADRs, observations, and knowledge need review or team history. Keep independent systems in their own Git repositories; the workbench records contracts and decisions, not their source history.

In `overlay` mode, Assay should not enter your product repo by default. `assay attach --privacy private` writes `/.assay/` to the repo-local `.git/info/exclude` and leaves tracked project files alone. If you want versioned Assay memory without polluting product commits, use `--privacy private-git` to initialize a separate Git repository inside `.assay/`.

## What Assay deliberately does not do

Assay does not run a model for you, hide your files in a database, or ask you to trust a magic agent loop. Your work remains plain files. The value is the structure: sources stay traceable, analyses can carry observations, and important choices can become ADRs or reusable knowledge instead of folklore. Explicit commands record decisions without trying to mechanically judge whether the prose is good enough.

## Learn more

- [Layout modes](docs/layout-modes.md)
- [Command reference](docs/commands.md)
- [Donor adoption](docs/donor-adoption.md)
- [Workspace layout](docs/workspace-layout.md)
- [Contributing](CONTRIBUTING.md)

If Assay saves you from re-reading the same sources twice, star it so other agent builders can find it.

---

linux.do
