#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm check
node scripts/pack-check.mjs
