# Adoption workflow

Use `metasystem adopt` when the current directory already contains a non-MetaSystem project and the user wants to rebuild it as a clean MetaSystem workspace.

## Pre-flight

```bash
cd <existing-project>
metasystem adopt --dry-run
```

Review the dry-run output. It lists every file and directory that will be archived. Confirm with the user before proceeding.

## Apply

```bash
metasystem adopt --apply --name <project-name>
```

What happens:

1. All root-level children are moved to `.old/<timestamp>/`.
2. `.git/` is preserved at the project root (not archived).
3. A standard MetaSystem scaffold is created.
4. An adoption manifest is written to `.old/<timestamp>/.adoption-manifest.json`.

If the target already has a `.framework/manifest.json`, the CLI refuses to adopt — use `update` or `migrate-layout` instead.

## Post-adoption steps

After adoption, follow these steps in order:

1. **Inspect** `.old/<timestamp>/` and its adoption manifest to understand what was archived.

2. **Write an adoption analysis** under `analyses/` describing what each meaningful old artifact is and where it should live in the new structure.

3. **Confirm the target direction** when the mapping changes project structure, build behavior, public docs, or user-facing semantics. Ask the user before making irreversible moves.

4. **Move old artifacts** into the appropriate new locations after the direction is clear. Do not default to copying. Do not assume every artifact belongs in one fixed directory.

5. **Validate** with `metasystem check` and any project-specific validation after moves.

## Cleanup

Do not delete `.old/<timestamp>/` until the user explicitly accepts the migrated structure or a separate cleanup task is created. The archive is a staging source, not the final organization.
