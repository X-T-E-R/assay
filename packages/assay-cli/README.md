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

The default check covers workspace structure and persisted-record integrity.
Add `--advisories` to request non-blocking workflow and content reminders.

Add an external source. A Git repository or URL becomes a tracked checkout; a
plain directory or archive is copied in once.

```powershell
node ..\assay\packages\assay-cli\dist\cli.js source add <repo-or-dir> repo-name
node ..\assay\packages\assay-cli\dist\cli.js source status repo-name
node ..\assay\packages\assay-cli\dist\cli.js source sync repo-name
node ..\assay\packages\assay-cli\dist\cli.js source capture repo-name
```

A checkout-backed source keeps its bytes in `sources/<alias>/checkout/`; copied
content lives in `sources/<alias>/content/`. The ledger is `observations/`, one
cheap append record per look. `source capture` writes `captures/<id>/` with the
bytes and their integrity manifest, and is the only routine command that hashes a
tree. `sync` and `switch` apply to checkout-backed sources; they record an
`observed with local modifications` advisory rather than refusing a checkout that
holds uncommitted work.

Track selected source material after it is adopted into a registered system:

```powershell
node ..\assay\packages\assay-cli\dist\cli.js source adoption register --file source-adoption.yaml
node ..\assay\packages\assay-cli\dist\cli.js source adoption status <adoption>
node ..\assay\packages\assay-cli\dist\cli.js source adoption decide <adoption> --target <id> --outcome accept
```

Source adoption inspection and evidence commands are optional tools. Evidence blocks
acceptance only when the definition explicitly declares it `required`.

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
