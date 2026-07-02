# Commands

Run workspace commands from inside an Assay workspace. Most commands walk up to find `.framework/manifest.json`; pass `--root <dir>` when operating on another workspace.

## Common Commands

```bash
# Workspace lifecycle
assay init [target-dir] --name <project> --archetype <name> [--git] [--force] [--create-new] [--no-track] [--no-agents]
assay check [--root <dir>]
assay status [--root <dir>]
assay update [--root <dir>] [--dry-run] [--agents] [--force | --skip-all | --create-new] [--no-track]
assay migrate-layout [--root <dir>] [--dry-run | --apply] [--backup]
assay archetype [--root <dir>] [--json]
assay archetype list [--root <dir>] [--json]

# Sources, analyses, and iterations
assay source add <repo-or-dir> [alias] [--root <dir>] [--branch <branch>] [--capture checkout|archive]
assay source sync [alias] [--root <dir>] [--branch <branch>] [--ref <ref>] [--class same|patch|normal|major|replacement]
assay source switch <alias> <branch-or-ref> [--root <dir>] [--sync]
assay source status [alias] [--root <dir>]
assay source diff <alias> [--root <dir>] [--since <observation>]
assay source log <alias> [--root <dir>]
assay absorb <source-dir> [--name <name>] [--root <dir>] [--as problem|intake]
assay reference add <source-dir> <name> [--root <dir>]
assay analysis new <title> [--root <dir>] [--for-source <alias>] [--observation <id-or-path>] [--for-reference <path>]
assay analysis close <path> --exit adopt|reject|experiment|adr [--note <note>] [--allow-empty] [--root <dir>]
assay iteration start <title> [--root <dir>]
assay iteration close <selector> --result applied|rejected|retest [--note <note>] [--root <dir>]
assay event capture --kind observation|analysis|decision|gotcha|note --text <text> [--root <dir>]
assay knowledge add <type> <title> [--from-analysis <path>] [--from-iteration <path>] [--root <dir>]

# Systems, ADRs, and project registry
assay system register <path> [--root <dir>] [--name <name>] [--vcs independent-git|embedded|none] [--vcs-ref <ref>] [--system-version <version>] [--primary] [--supersedes <names>]
assay system promote <selector> [--root <dir>]
assay system archive <selector> [--root <dir>] [--dry-run | --apply]
assay system list [--root <dir>] [--status primary|active|superseded|archived] [--json]
assay system show <selector> [--root <dir>] [--json]
assay adr new <title> [--from-analysis <path>] [--from-iteration <path>] [--force] [--root <dir>]
assay adr accept <selector> [--root <dir>]
assay adr supersede <old-selector> <new-selector> [--root <dir>]
assay adr deprecate <selector> [--root <dir>]
assay adr list [--root <dir>] [--status proposed|accepted|superseded|deprecated] [--json]
assay adr show <selector> [--root <dir>] [--json]
assay projects
assay projects list [--json] [--all] [--status active|missing|uninstalled]
assay projects scan <roots...> [--json]
assay projects show <selector> [--json]
assay projects forget <selector>
assay projects prune [--dry-run] [--json]
```

The built-in archetypes are `library`, `study`, `solve`, `science`, `evaluation`, and `explore`. Use `assay archetype list` to see built-ins plus custom YAML archetypes from the current project and `~/.assay/archetypes`.

`init`, successful `update`, and successful `adopt --apply` write a user-local project registry under `~/.assay/projects` by default. Use `--no-track` on those commands, or set `ASSAY_NO_TRACK=1`, to skip registry writes. The `assay projects` commands manage registry metadata only; they never delete workspace files.

`init` and successful `adopt --apply` also add a short Assay-managed block to root `AGENTS.md` by default. Use `--no-agents` on those commands to skip it. Ordinary `assay update` refreshes the block only when it already exists; `assay update --agents` creates or re-enables it.

If `AGENTS.md` contains incomplete `<!-- ASSAY:START -->` / `<!-- ASSAY:END -->` markers, Assay leaves the file unchanged and reports the malformed block so you can fix or remove it manually.

## Adopt Existing Project

Use `adopt` when an ordinary project already occupies the directory where you want an Assay workspace. Always inspect the plan first:

```bash
cd /path/to/existing-project
assay adopt --dry-run
assay adopt --apply --name ExistingProject --analyze --no-track [--no-agents]
```

`--apply` moves direct root entries into `.old/<timestamp>/`, keeps `.git/` at the root, and initializes the Assay scaffold. `--analyze` also creates an adoption inventory analysis so you can decide where archived content belongs. Move files out of `.old/` after review; `assay check` warns while archived content remains there.
