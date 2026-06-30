# CLI setup and invocation

## How this skill finds the CLI

This skill lives inside the `metasystem-kit` repo at `skills/metasystem-builder`. It runs the repo's CLI directly — there is **no bundled copy** of the kit inside the skill. `packages/` in the repo is the single source of truth.

Install by cloning the repo and running the installer, which builds the workspace and junctions (Windows) / symlinks (POSIX) the skill into your skills directory:

```bash
git clone <repo-url> metasystem-kit
cd metasystem-kit
node scripts/install.mjs            # build + link into ~/.agents/skills
```

Useful flags: `--target <dir>` (skills dir), `--name <skill-name>`, `--force` (replace existing), `--no-build` (relink only), `--dry-run` (preview).

## Invoking the CLI

Use the skill-local launcher. It resolves through the junction/symlink back to the repo, walks up to find the built CLI, and runs it:

```bash
node <skill-root>/scripts/metasystem.mjs <command>
```

`<skill-root>` is wherever the skill was installed (e.g. `~/.agents/skills/metasystem-builder`). The launcher needs no absolute paths — keep the cloned repo in place so the link resolves back to it.

## Building (required once)

`dist/` is a build artifact and is **not** committed to git. `scripts/install.mjs` builds it for you; to build manually:

```bash
cd <repo-root>
pnpm install --frozen-lockfile
pnpm build
```

The compiled entry point the launcher runs:

```text
packages/metasystem-framework-cli/dist/cli.js
```

The launcher fails clearly if the skill is not installed from inside the repo (cannot locate the repo) or if the repo is not yet built (`dist/` missing), with the build command in the message.

## Direct invocation (debugging)

To bypass the launcher, run the built CLI directly from the repo:

```bash
node <repo-root>/packages/metasystem-framework-cli/dist/cli.js <command>
```

A global `metasystem` command (via `npm link` in `packages/metasystem-framework-cli`) is optional and only meant for interactive human use, not agent workflows.

## Working directory conventions

All workspace commands (`init`, `adopt`, `check`, `status`, `update`, `migrate-layout`, `reference add`, `analysis new`, `analysis close`, `iteration start`, `iteration close`, `knowledge add`, `adr new|accept|supersede|deprecate|list|show`, `system register|promote|archive|list|show`) default to `process.cwd()` and walk up to discover `.framework/manifest.json`.

Use `cd <target-dir>` before running commands, or pass `--root <path>` / `[target-dir]` only when operating on a workspace from another directory.

## Project registry

The CLI tracks initialized workspaces in `~/.metasystem/projects`. Registry commands:

```bash
metasystem projects list              # list known workspaces
metasystem projects show <selector>   # inspect one workspace (selector required)
metasystem projects scan <roots...>   # discover workspaces by manifest
metasystem projects prune --dry-run   # preview stale record cleanup
metasystem projects forget <selector> # remove a registry record (never deletes project files)
```

These commands operate on registry metadata only and never modify project files.

## Systems registry (per-workspace)

Distinct from the project registry, each workspace has a per-workspace systems registry at `.framework/systems-registry.json` introduced in layout v3. Manage it with the `system` command group rather than editing the JSON directly:

```bash
metasystem system register <path> [--vcs ...] [--primary] [--supersedes ...] [--system-version ...]
metasystem system promote <selector>
metasystem system archive <selector> --dry-run | --apply
metasystem system list [--status ...] [--json]
metasystem system show <selector>
```

Selectors can be the full system name or a unique name prefix.

## ADR index (per-workspace)

Each workspace can track architecture decision records in `.framework/adrs.json` with markdown files under `knowledge/decisions/`. Manage ADRs with the `adr` command group rather than editing the JSON directly:

```bash
metasystem adr new "Title" [--from-analysis <path>] [--from-iteration <path>]
metasystem adr accept <selector>
metasystem adr supersede <old-selector> <new-selector>
metasystem adr deprecate <selector>
metasystem adr list [--status proposed|accepted|superseded|deprecated] [--json]
metasystem adr show <selector> [--json]
```

Selectors can be the full ADR id, a unique id prefix, or the ADR number.
