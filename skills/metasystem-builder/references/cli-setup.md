# CLI setup and invocation

## Building from source

The `metasystem` CLI ships as part of the `metasystem-kit` monorepo. Build once:

```bash
cd <path-to-metasystem-kit>
pnpm install
pnpm build
```

The compiled entry point is:

```text
packages/metasystem-framework-cli/dist/cli.js
```

## Making the CLI accessible

Choose one of three approaches:

1. **Global link** (recommended for daily use):

   ```bash
   cd packages/metasystem-framework-cli
   npm link
   ```

   Then invoke as `metasystem <command>` from any directory.

2. **Direct path** (no install needed):

   ```bash
   node <path-to-metasystem-kit>/packages/metasystem-framework-cli/dist/cli.js <command>
   ```

3. **npx** (if published to a registry):

   ```bash
   npx metasystem-framework-cli <command>
   ```

## Working directory conventions

All workspace commands (`init`, `adopt`, `check`, `status`, `update`, `migrate-layout`, `reference add`, `analysis new`, `analysis close`, `iteration start`, `iteration close`, `knowledge add`, `system register|promote|archive|list|show`) default to `process.cwd()` and walk up to discover `.framework/manifest.json`.

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
