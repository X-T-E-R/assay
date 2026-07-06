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

Invoke-Checked "pnpm" @("check")

$tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "assay-smoke-" + [System.Guid]::NewGuid().ToString("N")))
$previousRegistryRoot = $env:ASSAY_PROJECT_REGISTRY_ROOT
try {
  $demo = Join-Path $tmp.FullName "demo"
  $registry = Join-Path $tmp.FullName "registry"
  $cli = Join-Path $repoRoot "packages\assay-cli\dist\cli.js"
  $env:ASSAY_PROJECT_REGISTRY_ROOT = $registry
  Invoke-Checked "node" @($cli, "--help")
  New-Item -ItemType Directory -Path $demo | Out-Null
  Push-Location $demo
  try {
    Invoke-Checked "node" @($cli, "init", "--name", "Assay Smoke")
    Invoke-Checked "node" @($cli, "check")
    Invoke-Checked "node" @($cli, "status")
    Invoke-Checked "node" @($cli, "update", "--dry-run")
    Invoke-Checked "node" @($cli, "projects", "list", "--json")
    Invoke-Checked "node" @($cli, "migrate-layout", "--dry-run")
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
    Remove-Item Env:\ASSAY_PROJECT_REGISTRY_ROOT -ErrorAction SilentlyContinue
  }
  else {
    $env:ASSAY_PROJECT_REGISTRY_ROOT = $previousRegistryRoot
  }
  if (Test-Path -LiteralPath $tmp.FullName) {
    Remove-Item -LiteralPath $tmp.FullName -Recurse -Force
  }
}

Invoke-Checked "node" @((Join-Path $repoRoot "scripts\check-public-example.mjs"))

Write-Host "Assay checks passed."
