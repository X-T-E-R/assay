$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$packageRoot = "packages\metasystem-framework-cli"
$env:PYTHONPATH = Join-Path $packageRoot "src"

Push-Location $packageRoot
try {
  python -m unittest discover -s tests -v
  python -m compileall -q src scripts tests
}
finally {
  Pop-Location
}

$tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "metasystem-kit-smoke-" + [System.Guid]::NewGuid().ToString("N")))
try {
  $demo = Join-Path $tmp.FullName "demo"
  python "$packageRoot\scripts\bootstrap_framework.py" init $demo --name "MetaSystem Smoke"
  python "$packageRoot\scripts\bootstrap_framework.py" check --root $demo
  python "$packageRoot\scripts\bootstrap_framework.py" status --root $demo | Out-Null
  python "$packageRoot\scripts\bootstrap_framework.py" update --root $demo --dry-run | Out-Null
}
finally {
  if (Test-Path -LiteralPath $tmp.FullName) {
    Remove-Item -LiteralPath $tmp.FullName -Recurse -Force
  }
}

Write-Host "MetaSystem Kit checks passed."
