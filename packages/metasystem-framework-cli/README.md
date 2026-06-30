# assay-cli

Commander-based TypeScript CLI adapter for Assay framework workspaces.

The CLI package owns process-facing behavior only:

- command definitions and option parsing;
- mapping CLI options to `assay-core` operations;
- formatting structured core results for terminal output;
- mapping known user/runtime errors to exit codes.

Business logic belongs in `assay-core` so GUI and other adapters can reuse it without shelling out to `assay`.

## Local Usage

Build first, then run the compiled CLI:

```powershell
pnpm --filter assay-cli build
node packages\assay-cli\dist\cli.js --help
mkdir ..\assay-demo
cd ..\assay-demo
node ..\assay\packages\assay-cli\dist\cli.js init --name Assay
node ..\assay\packages\assay-cli\dist\cli.js check
```

To convert an existing project into a clean Assay workspace, run from that
project root:

```powershell
node ..\assay\packages\assay-cli\dist\cli.js adopt --dry-run
node ..\assay\packages\assay-cli\dist\cli.js adopt --apply --name Assay
```

## Development

```powershell
pnpm --filter assay-cli build
pnpm --filter assay-cli typecheck
pnpm --filter assay-cli test
```

Command behavior is checked by package tests and the repository-level `pnpm smoke` TypeScript CLI flow.
