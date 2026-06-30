# CLI setup and invocation

> 中文版: [cli-setup.zh.md](cli-setup.zh.md)

## How this skill finds the CLI

This skill lives inside the `assay` repo at `skills/assay-builder`. It runs the repo's CLI directly — there is **no bundled copy** of the kit inside the skill. `packages/` in the repo is the single source of truth.

Install by cloning the repo and running the installer, which builds the workspace and junctions (Windows) / symlinks (POSIX) the skill into your skills directory:

```bash
git clone <repo-url> assay
cd assay
node scripts/install.mjs            # build + link into ~/.agents/skills
```

Useful flags: `--target <dir>` (skills dir), `--name <skill-name>`, `--force` (replace existing), `--no-build` (relink only), `--dry-run` (preview).

## Invoking the CLI

Use the skill-local launcher. It resolves through the junction/symlink back to the repo, walks up to find the built CLI, and runs it:

```bash
node <skill-root>/scripts/assay.mjs <command>
```

`<skill-root>` is wherever the skill was installed (e.g. `~/.agents/skills/assay-builder`). The launcher needs no absolute paths — keep the cloned repo in place so the link resolves back to it.

## Building (required once)

`dist/` is a build artifact and is **not** committed to git. `scripts/install.mjs` builds it for you; to build manually:

```bash
cd <repo-root>
pnpm install --frozen-lockfile
pnpm build
```

The compiled entry point the launcher runs:

```text
packages/assay-cli/dist/cli.js
```

The launcher fails clearly if the skill is not installed from inside the repo (cannot locate the repo) or if the repo is not yet built (`dist/` missing), with the build command in the message.

## Direct invocation (debugging)

To bypass the launcher, run the built CLI directly from the repo:

```bash
node <repo-root>/packages/assay-cli/dist/cli.js <command>
```

A global `assay` command (via `npm link` in `packages/assay-cli`) is optional and only meant for interactive human use, not agent workflows.

## Working directory conventions

All workspace commands (`init`, `adopt`, `check`, `status`, `update`, `migrate-layout`, `reference add`, `analysis new`, `analysis close`, `iteration start`, `iteration close`, `knowledge add`, `adr new|accept|supersede|deprecate|list|show`, `system register|promote|archive|list|show`) default to `process.cwd()` and walk up to discover `.framework/manifest.json`.

Use `cd <target-dir>` before running commands, or pass `--root <path>` / `[target-dir]` only when operating on a workspace from another directory.

## Project registry

The CLI tracks initialized workspaces in `~/.assay/projects`. Registry commands:

```bash
assay projects list              # list known workspaces
assay projects show <selector>   # inspect one workspace (selector required)
assay projects scan <roots...>   # discover workspaces by manifest
assay projects prune --dry-run   # preview stale record cleanup
assay projects forget <selector> # remove a registry record (never deletes project files)
```

These commands operate on registry metadata only and never modify project files.

## Systems registry (per-workspace)

Distinct from the project registry, each workspace has a per-workspace systems registry at `.framework/systems-registry.json` introduced in layout v3. Manage it with the `system` command group rather than editing the JSON directly:

```bash
assay system register <path> [--vcs ...] [--primary] [--supersedes ...] [--system-version ...]
assay system promote <selector>
assay system archive <selector> --dry-run | --apply
assay system list [--status ...] [--json]
assay system show <selector>
```

Selectors can be the full system name or a unique name prefix.

## ADR index (per-workspace)

Each workspace can track architecture decision records in `.framework/adrs.json` with markdown files under `knowledge/decisions/`. Manage ADRs with the `adr` command group rather than editing the JSON directly:

```bash
assay adr new "Title" [--from-analysis <path>] [--from-iteration <path>]
assay adr accept <selector>
assay adr supersede <old-selector> <new-selector>
assay adr deprecate <selector>
assay adr list [--status proposed|accepted|superseded|deprecated] [--json]
assay adr show <selector> [--json]
```

Selectors can be the full ADR id, a unique id prefix, or the ADR number.
