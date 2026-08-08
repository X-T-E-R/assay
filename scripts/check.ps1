$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [string[]]$Arguments = @()
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

# Windows filesystem-heavy suites are deterministic when test files run one at
# a time. Test-local Promise concurrency remains intact, while Linux keeps the
# ordinary parallel `pnpm check` path in check.sh.
Invoke-Checked "pnpm" @("check:windows")

$tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "assay-smoke-" + [System.Guid]::NewGuid().ToString("N")))
$previousRegistryRoot = $env:ASSAY_WORKSPACES_ROOT
try {
  $demo = Join-Path $tmp.FullName "demo"
  $registry = Join-Path $tmp.FullName "registry"
  $cli = Join-Path $repoRoot "packages\assay-cli\dist\cli.js"
  $env:ASSAY_WORKSPACES_ROOT = $registry
  Invoke-Checked "node" @($cli, "--help")
  New-Item -ItemType Directory -Path $demo | Out-Null
  Push-Location $demo
  try {
    Invoke-Checked "node" @($cli, "init", "--name", "Assay Smoke")
    Invoke-Checked "node" @($cli, "check")
    Invoke-Checked "node" @($cli, "status")
    Invoke-Checked "node" @($cli, "update", "--dry-run")
    Invoke-Checked "node" @($cli, "workspace", "list", "--json")
    Invoke-Checked "node" @($cli, "workspace", "track", $demo)
    Invoke-Checked "node" @($cli, "workspace", "list", "--json")
  }
  finally {
    Pop-Location
  }

  $adopted = Join-Path $tmp.FullName "adopted"
  New-Item -ItemType Directory -Path (Join-Path $adopted "src") | Out-Null
  Set-Content -Path (Join-Path $adopted "README.md") -Value "# Existing Project"
  Set-Content -Path (Join-Path $adopted "src\index.ts") -Value "export const legacy = true;"
  Push-Location $adopted
  try {
    Invoke-Checked "node" @($cli, "adopt", "--name", "Adopted Smoke")
    Invoke-Checked "node" @($cli, "adopt", "--apply", "--name", "Adopted Smoke")
    Invoke-Checked "node" @($cli, "check")
    $archiveRoot = Join-Path $adopted ".old"
    $archives = @(Get-ChildItem -LiteralPath $archiveRoot -Directory)
    if ($archives.Count -ne 1) {
      throw "Expected one adoption archive, found $($archives.Count)."
    }
    $legacySource = Join-Path $archives[0].FullName "src\index.ts"
    if (-not (Test-Path -LiteralPath $legacySource)) {
      throw "Adoption archive did not contain the legacy source file."
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  if ($null -eq $previousRegistryRoot) {
    Remove-Item Env:\ASSAY_WORKSPACES_ROOT -ErrorAction SilentlyContinue
  }
  else {
    $env:ASSAY_WORKSPACES_ROOT = $previousRegistryRoot
  }
  if (Test-Path -LiteralPath $tmp.FullName) {
    Remove-Item -LiteralPath $tmp.FullName -Recurse -Force
  }
}

Invoke-Checked "node" @((Join-Path $repoRoot "scripts\check-public-example.mjs"))

Write-Host "Assay checks passed."
