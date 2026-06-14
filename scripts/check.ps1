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

$packageRoot = "packages\metasystem-framework-cli-python"
$env:PYTHONPATH = Join-Path $packageRoot "src"

Push-Location $packageRoot
try {
  Invoke-Checked "python" @("-m", "unittest", "discover", "-s", "tests", "-v")
  Invoke-Checked "python" @("-m", "compileall", "-q", "src", "scripts", "tests")
}
finally {
  Pop-Location
}

$tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "metasystem-kit-smoke-" + [System.Guid]::NewGuid().ToString("N")))
try {
  $demo = Join-Path $tmp.FullName "demo"
  Invoke-Checked "python" @("$packageRoot\scripts\bootstrap_framework.py", "init", $demo, "--name", "MetaSystem Smoke")
  Invoke-Checked "python" @("$packageRoot\scripts\bootstrap_framework.py", "check", "--root", $demo)
  Invoke-Checked "python" @("$packageRoot\scripts\bootstrap_framework.py", "status", "--root", $demo)
  Invoke-Checked "python" @("$packageRoot\scripts\bootstrap_framework.py", "update", "--root", $demo, "--dry-run")
}
finally {
  if (Test-Path -LiteralPath $tmp.FullName) {
    Remove-Item -LiteralPath $tmp.FullName -Recurse -Force
  }
}

Write-Host "MetaSystem Kit checks passed."
