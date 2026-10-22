param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Modules,
  [string]$NodeExe = "node"
)

$ErrorActionPreference = 'Stop'

function Has-Module {
  param([string]$Name)
  $set = $Modules.Split(',') | ForEach-Object { $_.Trim().ToUpperInvariant() }
  return $set -contains $Name.ToUpperInvariant()
}

function Resolve-Npm {
  param([string]$NodeExe)
  $nodePath = $null
  if (Test-Path $NodeExe) {
    $nodePath = (Resolve-Path $NodeExe).Path
  } else {
    $cmd = Get-Command $NodeExe -ErrorAction SilentlyContinue
    if ($cmd) { $nodePath = $cmd.Source }
  }
  if ($nodePath) {
    $nodeDir = Split-Path -Parent $nodePath
    foreach ($candidate in @('npm.cmd', 'npm.ps1', 'npm.exe')) {
      $npm = Join-Path $nodeDir $candidate
      if (Test-Path $npm) { return $npm }
    }
  }
  $globalNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($globalNpm) { return $globalNpm.Source }
  $globalNpm = Get-Command npm -ErrorAction SilentlyContinue
  if ($globalNpm) { return $globalNpm.Source }
  throw "npm was not found. Install Node.js with npm and make sure it is available in PATH."
}

function Invoke-NpmInstall {
  param([string]$ProjectDir, [string]$Label)
  if (-not (Test-Path (Join-Path $ProjectDir 'package.json'))) {
    Write-Host "[NPM] Skipping $Label, package.json not found."
    return
  }
  if (Test-Path (Join-Path $ProjectDir 'node_modules')) {
    Write-Host "[NPM] Using bundled dependencies for $Label."
    return
  }
  Push-Location $ProjectDir
  try {
    Write-Host "[NPM] Installing production dependencies for $Label..."
    if (Test-Path (Join-Path $ProjectDir 'package-lock.json')) {
      & $npm 'ci' '--omit=dev' '--no-audit' '--no-fund'
    } else {
      & $npm 'install' '--omit=dev' '--no-audit' '--no-fund'
    }
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed for $Label with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

$npm = Resolve-Npm -NodeExe $NodeExe
Write-Host "[NPM] Using npm: $npm"

if (Has-Module 'RIS') {
  Invoke-NpmInstall -ProjectDir (Join-Path $InstallDir 'RIS\backend') -Label 'RIS Backend'
  Invoke-NpmInstall -ProjectDir (Join-Path $InstallDir 'tools\backup-agent') -Label 'Backup Agent'
  Invoke-NpmInstall -ProjectDir (Join-Path $InstallDir 'tools\simrs-db-bridge') -Label 'SIMRS DB Bridge'
}

if (Has-Module 'PACS_DIMSE') {
  Invoke-NpmInstall -ProjectDir (Join-Path $InstallDir 'PACS') -Label 'PACS DICOMweb'
}

if (Has-Module 'DESKTOP_VIEWER') {
  Invoke-NpmInstall -ProjectDir (Join-Path $InstallDir 'PRIMARY VIEWER') -Label 'Primary Diagnostic Viewer'
}

if (Has-Module 'MOBILE_VIEWER') {
  Invoke-NpmInstall -ProjectDir (Join-Path $InstallDir 'MOBILITY VIEWER') -Label 'Mobile Viewer'
}

if (Has-Module 'ECG_VIEWER') {
  Invoke-NpmInstall -ProjectDir (Join-Path $InstallDir 'ECG VIEWER') -Label 'ECG Viewer'
}

Write-Host "[NPM] Dependency installation completed."
