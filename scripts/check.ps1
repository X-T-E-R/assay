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

$tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "metasystem-kit-smoke-" + [System.Guid]::NewGuid().ToString("N")))
$previousRegistryRoot = $env:METASYSTEM_PROJECT_REGISTRY_ROOT
try {
  $demo = Join-Path $tmp.FullName "demo"
  $registry = Join-Path $tmp.FullName "registry"
  $cli = Join-Path $repoRoot "packages\metasystem-framework-cli\dist\cli.js"
  $env:METASYSTEM_PROJECT_REGISTRY_ROOT = $registry
  Invoke-Checked "node" @($cli, "--help")
  New-Item -ItemType Directory -Path $demo | Out-Null
  Push-Location $demo
  try {
    Invoke-Checked "node" @($cli, "init", "--name", "MetaSystem Smoke")
    Invoke-Checked "node" @($cli, "check")
    Invoke-Checked "node" @($cli, "status")
    Invoke-Checked "node" @($cli, "update", "--dry-run")
    Invoke-Checked "node" @($cli, "projects", "list", "--json")
    Invoke-Checked "node" @($cli, "migrate-layout", "--dry-run")
  }
  finally {
    Pop-Location
  }
}
finally {
  if ($null -eq $previousRegistryRoot) {
    Remove-Item Env:\METASYSTEM_PROJECT_REGISTRY_ROOT -ErrorAction SilentlyContinue
  }
  else {
    $env:METASYSTEM_PROJECT_REGISTRY_ROOT = $previousRegistryRoot
  }
  if (Test-Path -LiteralPath $tmp.FullName) {
    Remove-Item -LiteralPath $tmp.FullName -Recurse -Force
  }
}

Write-Host "MetaSystem Kit checks passed."
