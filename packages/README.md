# Packages

This monorepo contains one package:

- `assay/` — the published `assay` package and its `assay` binary. It depends on
  `absorb-anything-core`, `absorb-anything`, and `own-work`, and adds only the
  suite lifecycle commands, the merged object table, and the mount that puts
  both halves under one binary.

The package requires Node.js >=22.13.0. Repository commands use the pinned pnpm
11.3.0.

## Package boundaries

Everything below the suite surface belongs to a sibling repository:

- `absorb-anything-core` owns the envelope, manifest schema, layout resolvers,
  managed receipt, events, update planning, typed errors, and the
  Source/Analysis/Knowledge objects.
- `absorb-anything` owns the `absorb` CLI and its command tree.
- `own-work` owns Task, Roadmap, Spec, System and the `ownwork` CLI.

Rules that follow from that:

- Do not reimplement or wrap object behaviour here. If a mounted command is
  wrong, fix it in its own repository.
- `src/lifecycle.ts` composes half-level functions (`initFramework`,
  `initOwnWork`, `checkFramework`, `checkOwnWork`, `getFrameworkStatus`,
  `getOwnWorkStatus`) and merges their results. It does not touch storage
  directly.
- `src/mount.ts` re-parents each half's Commander commands with a denylist. New
  commands appearing in either half are mounted automatically; a new top-level
  name collision must be added to the denylist and answered by the suite.
- `src/semantics.ts` retargets each half's command examples to `assay ...` and
  supplies the suite's own text for the two topics both halves define
  (`workspace`, `project`).

## Local development

The three repositories are checked out side by side. `pnpm-workspace.yaml`
overrides point the three sibling dependencies at those checkouts, so the halves
must be built before this package:

```powershell
cd ..\absorb-anything ; pnpm install ; pnpm build
cd ..\own-work        ; pnpm install ; pnpm build
cd ..\assay           ; pnpm install ; pnpm build
```

After building, invoke the CLI through the compiled entrypoint when testing
package boundaries:

```powershell
node packages/assay/dist/cli.js --help
node packages/assay/dist/cli.js init --name <project-name>
node packages/assay/dist/cli.js add <repo-or-dir> [alias]
node packages/assay/dist/cli.js task create "<title>"
node packages/assay/dist/cli.js check
node packages/assay/dist/cli.js status
node packages/assay/dist/cli.js prime
```

## Validation

From the repository root:

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
.\scripts\check.ps1
```

`pnpm smoke` drives the built CLI through help, version, init, both halves'
mutating commands, check, status, prime, and explain. `.\scripts\check.ps1`
additionally runs the publish-shape check.
