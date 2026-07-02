# Assay

**Study many. Grow your own.**

Assay is a CLI workbench for turning evidence into better systems: collect what matters, test it through a structure, record decisions, and grow durable knowledge for your own work.

> 中文版: [README.zh.md](README.zh.md)

## What Assay does

Assay keeps a general evidence loop in a repo-shaped workspace:

```text
evidence in -> structured checks -> decisions -> knowledge growth
```

Use it when external sources, experiments, objectives, or competing approaches should become traceable decisions and reusable systems instead of loose notes.

## How it works

Every workspace has an archetype. An archetype is **structure + conventions + common verbs** (`source`, `analysis`, `iteration`, `adr`, `check`), not a separate command family.

Built-in archetypes:

| Archetype | Role |
| --- | --- |
| `library` | Keep the shared base for systems and knowledge. |
| `study` | Learn from external systems one source at a time. |
| `solve` | Work toward one measurable objective through attempts and benchmarks. |
| `science` | Run evidence-oriented experiments from hypotheses to findings. |
| `evaluation` | Compare external candidates with criteria, scorecards, and ADRs. |
| `explore` | Incubate several local approaches before choosing a direction. |

`study`, `solve`, and `explore` form the main working relationship: study external examples, solve a known target, or explore when the target shape is still open. `evaluation` pairs with `study` for side-by-side external comparison; `science` pairs with `solve` for evidence-driven iteration.

Custom archetypes are copied YAML structures. Copy a built-in YAML into `.framework/archetypes/<name>.yaml` or `~/.assay/archetypes/<name>.yaml`, then change its directories, templates, modules, or manifest mode.

## Quick start

Build and link the CLI:

```bash
pnpm install
pnpm build
cd packages/assay-cli && npm link && cd ../..
```

Start a `study` workspace:

```bash
assay init ../assay-study --name AssayStudy --archetype study --no-track
cd ../assay-study
assay check
assay source add /path/to/project sample
assay analysis new "Review sample" --for-source sample
```

For a measurable target, choose `solve` instead:

```bash
assay init ../assay-solve --name AssaySolve --archetype solve --no-track
```

## Use it as an agent skill

The repo ships an agent-facing Skill at `skills/assay-builder`. It calls this clone's CLI directly, so keep the cloned repo in place after installing:

```bash
git clone <repo-url> assay
cd assay
node scripts/install.mjs
```

See `skills/assay-builder/references/cli-setup.md` for setup flags and invocation details.

## Learn more

- [Command reference](docs/commands.md)
- [Workspace layout](docs/workspace-layout.md)
- [Contributing](CONTRIBUTING.md)
