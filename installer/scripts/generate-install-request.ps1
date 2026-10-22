param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Modules,
  [string]$ProgramDataDir = "$env:ProgramData\VEXAPACS",
  [string]$InstallerVersion = "dev",
  [string]$NodeExe = "node"
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Path $ProgramDataDir -Force | Out-Null

$licenseCli = Join-Path $InstallDir 'scripts\license\license-cli.js'
if (-not (Test-Path $licenseCli)) {
  throw "License CLI was not found: $licenseCli"
}

$outFile = Join-Path $ProgramDataDir 'install-request.json'
$codeFile = Join-Path $ProgramDataDir 'install-request.txt'
& $NodeExe $licenseCli request --modules $Modules --installer-version $InstallerVersion --out $outFile --code-out $codeFile
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create install request with exit code $LASTEXITCODE."
}

Write-Host "Install request created: $outFile"
Write-Host "Install request code created: $codeFile"
