$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Join-Path $root 'DESKTOP VIEWER'
$mobilityDir = Join-Path $root 'MOBILITY VIEWER'
$pacsRoot = $env:DICOMWEB_PACS_ROOT
if (-not $pacsRoot) { $pacsRoot = 'http://127.0.0.1:5001' }

Write-Host "[START] Desktop Viewer (port 5991)"
$desktopJob = Start-Job -Name 'VexaDesktopDev' -ArgumentList $desktopDir, $pacsRoot -ScriptBlock {
  param($dir, $pacs)
  $env:NEXIA_RIS_SHARED_SECRET = 'Velodesktopview89287579@#VEXA@'
  $env:DICOMWEB_PACS_ROOT = $pacs
  Set-Location $dir
  npm run dev -- --host 0.0.0.0 --port 5991 2>&1 | Out-File (Join-Path $env:TEMP 'vexa-desktop-dev.log') -Append
}

Write-Host "[START] Mobility Viewer (port 5992)"
$mobileJob = Start-Job -Name 'VexaMobileDev' -ArgumentList $mobilityDir, $pacsRoot -ScriptBlock {
  param($dir, $pacs)
  $env:NEXIA_RIS_SHARED_SECRET = 'Velomobile987397497987#VEXA@'
  $env:DICOMWEB_PACS_ROOT = $pacs
  Set-Location $dir
  npm run dev -- --host 0.0.0.0 --port 5992 2>&1 | Out-File (Join-Path $env:TEMP 'vexa-mobile-dev.log') -Append
}

Write-Host 'Viewers started in background jobs.'
Write-Host 'Use: Get-Job -Name VexaDesktopDev, VexaMobileDev'
