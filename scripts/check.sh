#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pnpm check

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
demo="$tmp/demo"
registry="$tmp/registry"
cli="$repo_root/packages/metasystem-framework-cli/dist/cli.js"
export METASYSTEM_PROJECT_REGISTRY_ROOT="$registry"

node "$cli" --help >/dev/null
node "$cli" init "$demo" --name "MetaSystem Smoke"
node "$cli" check --root "$demo"
node "$cli" status --root "$demo" >/dev/null
node "$cli" update --root "$demo" --dry-run >/dev/null
node "$cli" projects list --json >/dev/null
node "$cli" migrate-layout --root "$demo" --dry-run >/dev/null

echo "MetaSystem Kit checks passed."
