# Restarts the VEXAPACS services that pre-stop-vexapacs-services.ps1 recorded.
#
# Called from DeinitializeSetup so that cancelling or failing the wizard still
# leaves the server running, instead of silently down. During a successful
# install the services have already been recreated and started by
# install-services.ps1, so this call is a no-op in practice.
param(
  [string]$ListPath = "",
  [string]$InstallDir = "$env:ProgramFiles\VEXAPACS-RIS"
)

$ErrorActionPreference = 'Continue'

$services = @()
if ($ListPath -and (Test-Path -LiteralPath $ListPath)) {
  try {
    $raw = Get-Content -LiteralPath $ListPath -Raw -Encoding UTF8
    $services = @($raw -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  } catch {
    Write-Host "[RESTORE] Tidak bisa membaca $ListPath : $($_.Exception.Message)"
  }
}

if ($services.Count -eq 0) {
  Write-Host "[RESTORE] Tidak ada service yang perlu dijalankan kembali."
  exit 0
}

foreach ($name in $services) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Host "[RESTORE] Service $name tidak ada (mungkin belum terpasang)."
    continue
  }
  if ($service.Status -eq 'Running') {
    Write-Host "[RESTORE] $name sudah berjalan."
    continue
  }
  try {
    Start-Service -Name $name -ErrorAction Stop
    Write-Host "[RESTORE] $name dijalankan kembali."
  } catch {
    Write-Host "[RESTORE] Gagal menjalankan $name : $($_.Exception.Message)"
  }
}
exit 0
