param(
  [string]$NssmExe = ""
)

$ErrorActionPreference = 'Stop'

if (-not $NssmExe) {
  $candidate = Join-Path $PSScriptRoot '..\..\vendor\nssm\nssm.exe'
  if (Test-Path $candidate) {
    $NssmExe = (Resolve-Path $candidate).Path
  } else {
    $NssmExe = 'nssm'
  }
}

if (-not (Test-Path $NssmExe) -and -not (Get-Command $NssmExe -ErrorAction SilentlyContinue)) {
  Write-Warning "NSSM was not found. Services cannot be removed automatically."
  exit 0
}

$services = @(
  'VexaRISBackend',
  'VexaRISFrontend',
  'VexaBackupAgent',
  'VexaSimrsDbBridge',
  'VexaPacsDicomweb',
  'VexaPacsDimse',
  'VexaMwlService',
  'VexaDesktopViewer',
  'VexaMobileViewer',
  'VexaEcgViewer',
  'VexaCaddy'
)

foreach ($service in $services) {
  if (-not (Get-Service -Name $service -ErrorAction SilentlyContinue)) {
    continue
  }
  Write-Host "[SERVICE] Removing $service"
  & $NssmExe stop $service | Out-Null
  Start-Sleep -Seconds 1
  & $NssmExe remove $service confirm | Out-Null
}

Write-Host "Service uninstall complete."
