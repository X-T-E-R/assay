$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/pack-check.mjs
exit $LASTEXITCODE
