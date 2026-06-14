#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pnpm check

package_root="$repo_root/packages/metasystem-framework-cli-python"
export PYTHONPATH="$package_root/src"

(
  cd "$package_root"
  python -m unittest discover -s tests -v
  python -m compileall -q src scripts tests
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
demo="$tmp/demo"

python "$package_root/scripts/bootstrap_framework.py" init "$demo" --name "MetaSystem Smoke"
python "$package_root/scripts/bootstrap_framework.py" check --root "$demo"
python "$package_root/scripts/bootstrap_framework.py" status --root "$demo" >/dev/null
python "$package_root/scripts/bootstrap_framework.py" update --root "$demo" --dry-run >/dev/null

echo "MetaSystem Kit checks passed."
