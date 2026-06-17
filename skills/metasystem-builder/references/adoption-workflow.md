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

If the target already has a `.framework/manifest.json`, the CLI refuses to adopt — use `update` or `migrate-layout` instead. If it has a v2 manifest but no `systems-registry.json`, run `migrate-layout --dry-run` first to plan the v2→v3 upgrade.

## Post-adoption steps

After adoption, follow these steps in order:

1. **Inspect** `.old/<timestamp>/` and its adoption manifest to understand what was archived.

2. **Write an adoption analysis** with `metasystem analysis new "<title>"` describing what each meaningful old artifact is and where it should live in the new structure.

3. **Confirm the target direction** when the mapping changes project structure, build behavior, public docs, or user-facing semantics. Ask the user before making irreversible moves.

4. **Move old artifacts** into the appropriate new locations after the direction is clear. Do not default to copying. Do not assume every artifact belongs in one fixed directory.

5. **Register the active system** with `metasystem system register`. If the system was a separate git repository before adoption (or will be), declare `--vcs independent-git` and add the system path to root `.gitignore` while exempting `system.yaml`. Use `--primary` for the active system; archived predecessors can be registered later or via `migrate-layout`.

6. **Close the adoption analysis** with `metasystem analysis close <path> --exit adopt|reject` so the decision is recorded in the event ledger.

7. **Validate** with `metasystem check` and `metasystem status`. Both should report the new `primary` system and zero open iterations from the adoption.

## Cleanup

Do not delete `.old/<timestamp>/` until the user explicitly accepts the migrated structure or a separate cleanup task is created. The archive is a staging source, not the final organization.
