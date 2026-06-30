# Adoption workflow

Use `assay adopt` when the current directory already contains a non-Assay project and the user wants to rebuild it as a clean Assay workspace.

## Pre-flight

```bash
cd <existing-project>
assay adopt --dry-run
```

Review the dry-run output. It lists every file and directory that will be archived. Confirm with the user before proceeding.

## Apply

```bash
assay adopt --apply --name <project-name>
```

What happens:

1. All root-level children are moved to `.old/<timestamp>/`.
2. `.git/` is preserved at the project root (not archived).
3. A standard Assay scaffold is created.
4. An adoption manifest is written to `.old/<timestamp>/.adoption-manifest.json`.

If the target already has a `.framework/manifest.json`, the CLI refuses to adopt — use `update` or `migrate-layout` instead. If it has a v2 manifest but no `systems-registry.json`, run `migrate-layout --dry-run` first to plan the v2→v3 upgrade.

## Post-adoption steps

After adoption, follow these steps in order:

1. **Inspect** `.old/<timestamp>/` and its adoption manifest to understand what was archived.

2. **Write an adoption analysis** with `assay analysis new "<title>"` (or get one automatically with `adopt --apply --analyze`) describing what each meaningful old artifact is and where it should live in the new structure.

3. **Propose a concrete move plan first**. For each archived entry, decide its destination and present the plan as a diff/preview or the inventory table. Do not default to "stop and wait" after archiving — the framework's job is to propose the direction, then apply on confirmation. Ask the user before making irreversible moves, but come with a plan, not a blank.

4. **Move old artifacts** into the appropriate new locations after the direction is confirmed. Do not default to copying. Do not assume every artifact belongs in one fixed directory. `check` warns on a lingering `.old/` until it is cleared, so the archive cannot become a silent graveyard.

5. **Register the active system** with `assay system register`. If the system was a separate git repository before adoption (or will be), declare `--vcs independent-git` and add the system path to root `.gitignore` while exempting `system.yaml`. Use `--primary` for the active system; archived predecessors can be registered later or via `migrate-layout`.

6. **Close the adoption analysis** with `assay analysis close <path> --exit adopt|reject` so the decision is recorded in the event ledger.

7. **Validate** with `assay check` and `assay status`. Both should report the new `primary` system and zero open iterations from the adoption. A lingering `.old/` warning means step 4 is incomplete.

## Cleanup

Do not delete `.old/<timestamp>/` until the user explicitly accepts the migrated structure or a separate cleanup task is created. The archive is a staging source, not the final organization.
