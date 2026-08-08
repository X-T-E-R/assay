# CLI setup and invocation

> 中文版: [cli-setup.zh.md](cli-setup.zh.md)

## Prerequisites

- Node.js >=22.13.0
- pnpm 11.3.0, as pinned by the repository `packageManager` field

Older Node versions are outside the supported installer and CLI runtime
contract.

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


Use `cd <target-dir>` before running commands, or pass `--root <path>` / `[target-dir]` only when operating on a workspace from another directory.

## Workspace index

Workspace indexing is explicit under `~/.assay/workspaces` and never happens during lifecycle/read commands:

```bash
assay workspace track [root]          # track one workspace explicitly
assay workspace discover <roots...>   # discover and track workspaces by manifest
assay workspace list                  # report record state without rewriting it
assay workspace forget <selector>     # remove an index record (never deletes project files)
```

These commands operate on registry metadata only and never modify project files.

## Systems registry (per-workspace)

Distinct from the optional global workspace index, each current workspace has a per-workspace systems registry at `.assay/systems-registry.json`. Manage it with the `system` command group rather than editing the JSON directly:

```bash
assay system register <path> [--vcs ...] [--primary] [--supersedes ...] [--system-version ...]
assay system update <selector> [--path ...] [--vcs ...] [--vcs-ref ...] [--system-version ...] [--primary] [--supersedes ...]
assay system promote <selector>
assay system archive <selector> --dry-run | --apply
assay system list [--status ...] [--json]
assay system show <selector>
```

Use `system register` for first-time records. If a system already exists and its metadata is wrong, use `system update <selector>` instead; for example, correct a system from `embedded` to `independent-git` with `assay system update skill-creator --vcs independent-git --vcs-ref main`. Omitted fields are preserved.

System selectors are exact Project-local registry keys. Prefix fallback is not supported.

## Repository validation

When maintaining the Assay repository, validate through the release scripts rather than a weaker ad hoc command:

```bash
./scripts/check.sh
```

```powershell
.\scripts\check.ps1
```

Those scripts build the TypeScript packages, run typecheck/lint/tests/smoke, and verify the committed `examples/framework-template` workspace with the built CLI.
