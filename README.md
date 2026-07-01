# Assay

**Study many. Grow your own.**

A CLI workbench for the systems, tools, and workflows you're tempted to borrow from — observe them as living sources, assay them through evaluation lenses, then distill the patterns worth keeping into your own.

> 中文版: [README.zh.md](README.zh.md)

## How it works

Assay manages a project workspace where studying external things and building your own run as one tracked loop:

```text
references -> analyses -> systems -> iterations -> knowledge
```

You add or absorb a source, analyze it, fold the parts worth keeping into your own system, iterate on that system, and promote durable findings into knowledge. Each step is a CLI command that writes an event, so the workspace records what you studied and what you decided — not just what files exist.

Two settings shape how a workspace behaves:

- **Archetype** — what kind of project this is: `research` (study many things), `contest` (work a single problem), or `library` (build a reusable system). It decides which capability packs are on.
- **Mode** — where absorbed sources land: `learning` treats external sources as references; `absorption` treats the source as *the* project and lands its materials in `problem/`. Use absorption when the whole workspace exists to rebuild or solve one specific thing.

You pick both at `init` and can read them back any time with `assay archetype`.

## Quick start

Install dependencies and build the TypeScript packages:

```bash
pnpm install
pnpm build
```

`pnpm build` produces the CLI at `packages/assay-cli/dist/cli.js`. Run it either way:

- Directly: `node /path/to/assay/packages/assay-cli/dist/cli.js <command>`
- As a global `assay` command, after `npm link` inside `packages/assay-cli`.

The examples below use `assay` for readability. Create and check your first workspace:

```bash
mkdir ../assay-demo
cd ../assay-demo
assay init --name Assay --archetype research --mode learning
assay check
assay status
```

Then add a living external source:

```bash
assay source add /path/to/some-project some-project
assay source status some-project
assay source sync some-project
assay source diff some-project
```

`source add` creates `references/<alias>/` with a shallow human entrance: `source.yaml`, current `checkout/`, selected `materials/`, `history.md`, and an internal `.assay/` observation ledger. For Git-backed sources, `checkout/` is the repository root, so `references/<alias>/checkout/.git` is expected.

Open and close an analysis for the source observation:

```bash
assay analysis new "Review some-project" --for-source some-project
# fill ## Key observations and the decision section in the opened analysis
assay analysis close analyses/references/<file>.md --exit adopt
assay check
assay status
```

`analysis close` refuses empty analysis shells by default. Closing a source-bound analysis marks the observation as reviewed, so `check` can clear stale-risk warnings for major changes.

For the older full-capture freeze-and-open-analysis flow, use `absorb`:

```bash
assay absorb /path/to/some-project --name some-project
# fill ## Key observations / ## Adopt / ## Reject in the opened analysis
assay analysis close analyses/<file>.md --exit adopt
```

`absorb` freezes the source, writes a case file, and opens a pre-filled analysis in one step. Closing the analysis marks the reference analyzed and records the decision — a frozen source with no analysis is unfinished work, and `assay check` will flag it.

## Common commands

Run these from inside the workspace; each walks up to find `.framework/manifest.json`. Pass `--root <dir>` to operate on a workspace elsewhere.

```bash
# Workspace lifecycle
assay init --name <project> --archetype research|contest|library --mode learning|absorption
assay check                              # structure + content-health validation
assay status                             # systems, open iterations, knowledge counts
assay update --dry-run                   # preview managed-file upgrades before applying
assay migrate-layout --dry-run           # plan an old-layout migration (v2 -> v3)

# The loop
assay source add <repo-or-dir> [alias] [--branch <branch>] [--capture checkout|thin|metadata|archive]
assay source sync [alias] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--sync]
assay source status [alias]
assay source diff <alias> [--since <observation>]
assay source log <alias>
assay absorb <source-dir> [--name <name>] [--as problem|intake]
assay reference add <source-dir> <name>  # legacy/full-capture freeze only, no analysis
assay analysis new "Title" [--for-source <alias>] [--observation <id>] [--for-reference <path>]
assay analysis close <path> --exit adopt|reject|experiment|adr [--allow-empty]
assay iteration start "Title"
assay iteration close <selector> --result applied|rejected|retest
assay knowledge add <type> "Title"

# Systems, ADRs, registries
assay system register <path> [--primary] [--vcs independent-git|embedded|none]
assay system promote|archive|list|show <selector>
assay adr new|accept|supersede|deprecate|list|show
assay projects list|scan|show|forget|prune
```

## Adopt an existing project

Use `adopt` when the current directory already holds an ordinary project and you want a clean Assay workspace around it. Always dry-run first.

```bash
cd /path/to/existing-project
assay adopt --dry-run
assay adopt --apply --name ExistingProject --analyze
```

`--apply` archives the current root under a timestamped `.old/`, keeps `.git/` in place, and creates the standard scaffold. `--analyze` opens an adoption inventory listing each archived entry with a suggested destination. Move archived content into the new structure once the direction is clear; `assay check` warns while `.old/` still has un-migrated content.

`assay init` and successful `assay update` runs register the workspace in a user-local registry at `~/.assay/projects`. The `assay projects` commands manage that registry's metadata only — they never delete project files.

## What a workspace contains

```text
.framework/   version, manifest, events, migrations, backups, registries
references/   living external sources, intake notes, and legacy frozen snapshots
problem/      the source being rebuilt or solved (absorption mode)
analyses/     reference analyses, gap analyses, candidate patterns
systems/      your own system implementations
iterations/   planned changes to your own systems
knowledge/    accepted, reusable knowledge — including ADRs under knowledge/decisions/
data/         samples, evaluation data, experiment inputs and outputs
releases/     release notes, packages, migration guides
```

`assay-core` owns the managed templates, manifest, update planning, and migration logic; the CLI is a thin adapter over it. Your files are protected by a manifest, hash checks, dry-run updates, and migration planning — `update` skips files you've edited unless you pass `--force`.

## Use it as an agent skill

The repo ships an agent-facing Skill at `skills/assay-builder` that runs this repo's CLI directly — no bundled copy. Install it by cloning the repo and running the installer, which builds the workspace and links the skill into your skills directory:

```bash
git clone <repo-url> assay
cd assay
node scripts/install.mjs            # build + link into ~/.agents/skills
```

Keep the cloned repo in place; the linked skill resolves back to it. See `skills/assay-builder/references/cli-setup.md` for flags and invocation details.

## Develop Assay

```text
packages/assay-core/      framework operations, schemas, templates, update/migration logic
packages/assay-cli/       Commander CLI adapter over the core package
skills/assay-builder/     agent-facing Skill
examples/framework-template/   a sanitized, generated workspace
docs/decisions/           this repo's own ADRs and migration notes
docs/background/          design notes and the references that informed the framework
scripts/                  validation and install helpers
```

Local development scripts:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
```

Run the full repository check before sending changes:

```bash
./scripts/check.sh        # or  .\scripts\check.ps1  on Windows PowerShell
```

The check runs build, typecheck, lint, tests, and a CLI smoke flow covering help, init, adopt dry-run/apply, check, status, update dry-run, project listing, and migration dry-run.

Keep the repository publishable: reusable code, templates, docs, and sanitized examples belong here; runtime logs, private references, local absolute paths, secrets, and build output (`dist/`) stay out. Future GUI code should import `assay-core` directly rather than shell out to the CLI.
