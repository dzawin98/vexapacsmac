param(
  [string]$InnoCompiler = "",
  [switch]$SkipPayloadBuild,
  [switch]$SkipAppBuild,
  [switch]$IncludeNodeModules
)

$ErrorActionPreference = 'Stop'

if (-not $InnoCompiler) {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      $InnoCompiler = $candidate
      break
    }
  }
}

if (-not $InnoCompiler -or -not (Test-Path $InnoCompiler)) {
  throw "ISCC.exe was not found. Install Inno Setup 6 or use -InnoCompiler."
}

if (-not $SkipPayloadBuild) {
  $prepareArgs = @()
  if ($SkipAppBuild) { $prepareArgs += '-SkipBuild' }
  if ($IncludeNodeModules) { $prepareArgs += '-IncludeNodeModules' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'prepare-payload.ps1') @prepareArgs
}

& $InnoCompiler (Join-Path $PSScriptRoot 'vexapacs-ris.iss')
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup compile failed with exit code $LASTEXITCODE."
}

Write-Host ""
$versionMatch = Select-String -Path (Join-Path $PSScriptRoot 'vexapacs-ris.iss') -Pattern 'OutputBaseFilename=(.+)$' | Select-Object -First 1
$outputName = if ($versionMatch) { $versionMatch.Matches[0].Groups[1].Value.Trim() } else { 'VEXAPACS-RIS-Setup' }
Write-Host "Installer output: $(Join-Path $PSScriptRoot "Output\$outputName.exe")" -ForegroundColor Green
