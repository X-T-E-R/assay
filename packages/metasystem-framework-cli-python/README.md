# MetaSystem Framework CLI

`metasystem` bootstraps and maintains versioned framework workspaces for external-system learning.

The CLI is intentionally small and dependency-free. It can initialize a workspace, check structure, report status, freeze references, create analysis cards, start iterations, and plan safe updates or layout migrations.

## Run From This Monorepo

From the repository root:

```powershell
$env:PYTHONPATH = "packages\metasystem-framework-cli-python\src"
python packages\metasystem-framework-cli-python\scripts\bootstrap_framework.py --help
```

## Install Locally

```powershell
cd packages\metasystem-framework-cli-python
python -m pip install -e .
```

After installation:

```powershell
metasystem --help
```

## Main Commands

```powershell
metasystem init <target-dir> --name <project-name>
metasystem check --root <target-dir>
metasystem status --root <target-dir>
metasystem update --root <target-dir> --dry-run
metasystem migrate-layout --root <target-dir> --dry-run
metasystem reference add <source-dir> <name> --root <target-dir>
metasystem analysis new "Reference analysis" --root <target-dir>
metasystem iteration start "CLI refactor" --root <target-dir>
```

## Package Design

- `cli.py`: command routing
- `scaffold.py`: init, check, status, reference, analysis, iteration
- `templates.py`: desired framework tree
- `manifest.py`: managed file manifest
- `updater.py`: dry-run update and layout migration planning
- `events.py`: JSONL event ledger
- `paths.py`, `hashing.py`, `reporting.py`: shared utilities
