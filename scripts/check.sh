#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pnpm check

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
demo="$tmp/demo"
registry="$tmp/registry"
cli="$repo_root/packages/assay-cli/dist/cli.js"
export ASSAY_PROJECT_REGISTRY_ROOT="$registry"

node "$cli" --help >/dev/null
mkdir -p "$demo"
(
  cd "$demo"
  node "$cli" init --name "Assay Smoke"
  node "$cli" check
  node "$cli" status >/dev/null
  node "$cli" update --dry-run >/dev/null
  node "$cli" projects list --json >/dev/null
  node "$cli" migrate-layout --dry-run >/dev/null
)

adopted="$tmp/adopted"
mkdir -p "$adopted/src"
printf '# Existing Project\n' >"$adopted/README.md"
printf 'export const legacy = true;\n' >"$adopted/src/index.ts"
(
  cd "$adopted"
  node "$cli" adopt --name "Adopted Smoke" >/dev/null
  node "$cli" adopt --apply --name "Adopted Smoke"
  node "$cli" check
  archive_count="$(find .old -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  test "$archive_count" = "1"
  test -f .old/*/src/index.ts
)

echo "Assay checks passed."
