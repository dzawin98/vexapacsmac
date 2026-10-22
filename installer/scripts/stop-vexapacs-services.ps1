# Stops everything that holds VEXAPACS-RIS binaries open, BEFORE Setup copies
# the new files.
#
# Why this is needed: Setup overwrites binaries during ssInstall, but services
# are only stopped later, in the postinstall step. Any process running out of
# the install directory therefore makes the file replace fail with
# "DeleteFile failed; code 5. Access is denied." — typically
# tools\service-monitor\VexaServiceMonitor.exe, which an operator has left open.
#
# The list of services actually stopped is written to -ListOut so a cancelled or
# failed install can put them back (see start-vexapacs-services.ps1).
param(
  [string]$InstallDir = "$env:ProgramFiles\VEXAPACS-RIS",
  [string]$ListOut = "",
  [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Continue'

function Write-Step {
  param([string]$Message)
  Write-Host "[PRESTOP] $Message"
}

$report = [ordered]@{
  stoppedServices = @()
  failedServices  = @()
  killedProcesses = @()
  stillRunning    = @()
}

# 1) The service monitor is a WinForms tool a user may have left open. Windows
#    cannot delete a running EXE, so this is the usual cause of code 5.
foreach ($proc in @(Get-Process -Name 'VexaServiceMonitor' -ErrorAction SilentlyContinue)) {
  try {
    Stop-Process -Id $proc.Id -Force -ErrorAction Stop
    $report.killedProcesses += ("VexaServiceMonitor({0})" -f $proc.Id)
    Write-Step "Menutup VexaServiceMonitor (PID $($proc.Id))"
  } catch {
    Write-Step "Tidak bisa menutup VexaServiceMonitor (PID $($proc.Id)): $($_.Exception.Message)"
  }
}

# 2) NSSM wraps node.exe, so an orphaned child survives a service stop and keeps
#    holding its files. Kill only processes living under this install directory.
$installFull = ''
try { $installFull = (Resolve-Path -LiteralPath $InstallDir -ErrorAction Stop).Path } catch { }
if ($installFull) {
  $prefix = $installFull.ToLowerInvariant()
  $orphans = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($prefix) })
  foreach ($orphan in $orphans) {
    try {
      Stop-Process -Id $orphan.ProcessId -Force -ErrorAction Stop
      $report.killedProcesses += ("node.exe({0})" -f $orphan.ProcessId)
      Write-Step "Menghentikan node.exe yatim (PID $($orphan.ProcessId))"
    } catch {
      Write-Step "Tidak bisa menghentikan node.exe (PID $($orphan.ProcessId)): $($_.Exception.Message)"
    }
  }
}

# 3) Stop the VEXAPACS services.
foreach ($service in @(Get-Service -Name 'Vexa*' -ErrorAction SilentlyContinue)) {
  if ($service.Status -eq 'Stopped') { continue }
  try {
    Stop-Service -Name $service.Name -Force -ErrorAction Stop
    $report.stoppedServices += $service.Name
    Write-Step "Menghentikan service $($service.Name)"
  } catch {
    $report.failedServices += ("{0}: {1}" -f $service.Name, $_.Exception.Message)
    Write-Step "Gagal menghentikan $($service.Name): $($_.Exception.Message)"
  }
}

# 4) Wait until they really are Stopped. A service that is still "StopPending"
#    keeps its file handles, so copying would fail anyway.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$pending = @()
do {
  $pending = @(Get-Service -Name 'Vexa*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -ne 'Stopped' })
  if ($pending.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

foreach ($service in $pending) {
  $report.stillRunning += $service.Name
  Write-Step "PERINGATAN: $($service.Name) masih $($service.Status) setelah $TimeoutSeconds detik"
}

# 5) Also wait for the monitor process to disappear from the process list.
$monitorDeadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $monitorDeadline) {
  if (@(Get-Process -Name 'VexaServiceMonitor' -ErrorAction SilentlyContinue).Count -eq 0) { break }
  Start-Sleep -Milliseconds 300
}
$monitorLeft = @(Get-Process -Name 'VexaServiceMonitor' -ErrorAction SilentlyContinue).Count
if ($monitorLeft -gt 0) {
  $report.stillRunning += 'VexaServiceMonitor'
  Write-Step "PERINGATAN: VexaServiceMonitor masih berjalan."
}

if ($ListOut) {
  try {
    $list = @($report.stoppedServices) -join ','
    [System.IO.File]::WriteAllText($ListOut, $list, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Step "Tidak bisa menulis daftar service ke $ListOut : $($_.Exception.Message)"
  }
}

$report | ConvertTo-Json -Compress -Depth 4
if ($report.stillRunning.Count -gt 0) { exit 1 }
exit 0
