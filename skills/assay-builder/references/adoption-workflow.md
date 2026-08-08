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


## Post-adoption steps

After adoption, follow these steps in order:

1. **Inspect** `.old/<timestamp>/` and its adoption manifest to understand what was archived.

2. **Write an adoption analysis** with `assay analysis new "<title>"` (or get one automatically with `adopt --apply --analyze`) describing what each meaningful old artifact is and where it should live in the new structure.

3. **Propose a concrete move plan first**. For each archived entry, decide its destination and present the plan as a diff/preview or the inventory table. Do not default to "stop and wait" after archiving — the framework's job is to propose the direction, then apply on confirmation. Ask the user before making irreversible moves, but come with a plan, not a blank.

4. **Move old artifacts** into the appropriate new locations after the direction is confirmed. Do not default to copying. Do not assume every artifact belongs in one fixed directory. `check --advisories` can list a lingering `.old/` while migration is still in progress.


6. **Close the adoption analysis** with `assay analysis close <path> --exit adopt|reject` so the decision is recorded in the event ledger.

7. **Validate** persisted structure with `assay check` and inspect the workspace with `assay status`. Run `assay check --advisories` if you also want reminders about lingering `.old/` material or unfinished analyses.

## Cleanup

Do not delete `.old/<timestamp>/` until the user explicitly accepts the migrated structure or a separate cleanup task is created. The archive is a staging source, not the final organization.
