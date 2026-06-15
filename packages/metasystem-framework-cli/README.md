# metasystem-framework-cli

Commander-based TypeScript CLI adapter for MetaSystem framework workspaces.

The CLI package owns process-facing behavior only:

- command definitions and option parsing;
- mapping CLI options to `metasystem-framework-core` operations;
- formatting structured core results for terminal output;
- mapping known user/runtime errors to exit codes.

Business logic belongs in `metasystem-framework-core` so GUI and other adapters can reuse it without shelling out to `metasystem`.

## Local Usage

Build first, then run the compiled CLI:

```powershell
pnpm --filter metasystem-framework-cli build
node packages\metasystem-framework-cli\dist\cli.js --help
mkdir ..\metasystem-demo
cd ..\metasystem-demo
node ..\metasystem-kit\packages\metasystem-framework-cli\dist\cli.js init --name MetaSystem
node ..\metasystem-kit\packages\metasystem-framework-cli\dist\cli.js check
```

## Development

```powershell
pnpm --filter metasystem-framework-cli build
pnpm --filter metasystem-framework-cli typecheck
pnpm --filter metasystem-framework-cli test
```

Command behavior is checked by package tests and the repository-level `pnpm smoke` TypeScript CLI flow.
