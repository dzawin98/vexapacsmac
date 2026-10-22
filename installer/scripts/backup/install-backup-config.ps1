param(
  [string]$ProgramDataDir = "$env:ProgramData\VEXAPACS",
  [string]$BackupRoot = "D:\VEXAPACS-Backup",
  [string]$DataDir = "$env:ProgramData\VEXAPACS\DATA",
  [string]$DbHost = "localhost",
  [string]$DbPort = "5432",
  [string]$DbUser = "postgres",
  [string]$DbPass = "velo",
  [string]$RisDbName = "vexaris_db",
  [string]$PacsDbName = "vexapacs_db",
  [string]$PostgresBinPath = ""
)

$ErrorActionPreference = 'Stop'

function Normalize-InstallerPath {
  param(
    [string]$Path,
    [string]$Fallback
  )
  $value = [string]$Path
  if (-not $value.Trim()) {
    $value = $Fallback
  }
  $value = $value.Trim().Trim('"')
  if ($value -match '(^|\s)-[A-Za-z][A-Za-z0-9]*\b') {
    throw "Invalid path received for backup configuration: [$value]"
  }
  if ($value -match '^[A-Za-z]:$') {
    return Join-Path ($value + '\') 'VEXAPACS'
  }
  return $value
}

function Ensure-InstallDirectory {
  param([string]$Path)
  if (-not $Path) { throw "Directory path is empty." }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  try {
    & icacls $Path `
      /grant '*S-1-5-18:(OI)(CI)(F)' `
      /grant '*S-1-5-32-544:(OI)(CI)(F)' `
      /grant '*S-1-5-32-545:(OI)(CI)(M)' `
      /T /C | Out-Null
  } catch {
    Write-Warning "Unable to update ACL for $Path`: $($_.Exception.Message)"
  }
}

function Resolve-PostgresBinPath {
  param([string]$Preferred)
  $preferredText = [string]$Preferred
  if ($preferredText.Trim()) {
    $candidate = $preferredText.Trim().Trim('"')
    if (Test-Path (Join-Path $candidate 'pg_dump.exe')) {
      return (Resolve-Path $candidate).Path
    }
  }

  $roots = @()
  if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'PostgreSQL') }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($programFilesX86) { $roots += (Join-Path $programFilesX86 'PostgreSQL') }

  $candidates = @()
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($versionDir in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {
      $versionNumber = 0
      [void][int]::TryParse($versionDir.Name, [ref]$versionNumber)
      $bin = Join-Path $versionDir.FullName 'bin'
      if (Test-Path (Join-Path $bin 'pg_dump.exe')) {
        $candidates += [pscustomobject]@{ Path = $bin; Version = $versionNumber; Priority = 0 }
      }
      $runtime = Join-Path $versionDir.FullName 'pgAdmin 4\runtime'
      if (Test-Path (Join-Path $runtime 'pg_dump.exe')) {
        $candidates += [pscustomobject]@{ Path = $runtime; Version = $versionNumber; Priority = 1 }
      }
    }
  }

  $detected = $candidates |
    Sort-Object @{ Expression = 'Priority'; Ascending = $true }, @{ Expression = 'Version'; Descending = $true } |
    Select-Object -First 1
  if ($detected) { return $detected.Path }
  return $preferredText.Trim().Trim('"')
}

function Get-JsonValue {
  param($Object, [string]$Name, $Default)
  if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) {
    $value = $Object.$Name
    if ($null -ne $value -and "$value" -ne '') { return $value }
  }
  return $Default
}

$ProgramDataDir = Normalize-InstallerPath -Path $ProgramDataDir -Fallback "$env:ProgramData\VEXAPACS"
$DataDir = Normalize-InstallerPath -Path $DataDir -Fallback (Join-Path $ProgramDataDir 'DATA')
$dataDrive = Split-Path -Qualifier $DataDir
if ($dataDrive) {
  $defaultBackupRoot = Join-Path ($dataDrive + '\') 'VEXAPACS-Backup'
} else {
  $defaultBackupRoot = Join-Path $ProgramDataDir 'Backup'
}
$BackupRoot = Normalize-InstallerPath -Path $BackupRoot -Fallback $defaultBackupRoot
$PostgresBinPath = Resolve-PostgresBinPath -Preferred $PostgresBinPath

Ensure-InstallDirectory -Path $ProgramDataDir
Ensure-InstallDirectory -Path $DataDir
try {
  Ensure-InstallDirectory -Path $BackupRoot
} catch {
  Write-Warning "Cannot create backup root '$BackupRoot': $($_.Exception.Message)"
  $BackupRoot = Join-Path $ProgramDataDir 'Backup'
  Write-Host "Falling back to BackupRoot: $BackupRoot"
  Ensure-InstallDirectory -Path $BackupRoot
}

$configPath = Join-Path $ProgramDataDir 'backup.config.json'
if (Test-Path $configPath) {
  try {
    $current = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  } catch {
    $current = $null
  }
} else {
  $current = $null
}

$config = [ordered]@{
  backupRoot = $BackupRoot
  dataPath = $DataDir
  programDataPath = $ProgramDataDir
  includeDicomData = [bool](Get-JsonValue $current 'includeDicomData' $true)
  includeProgramData = [bool](Get-JsonValue $current 'includeProgramData' $true)
  postgres = [ordered]@{
    host = $DbHost
    port = [int]$DbPort
    user = $DbUser
    password = $DbPass
    risDb = $RisDbName
    pacsDb = $PacsDbName
    binPath = $PostgresBinPath
  }
  services = @(
    'VexaRISBackend',
    'VexaRISFrontend',
    'VexaPacsDicomweb',
    'VexaPacsDimse',
    'VexaMwlService',
    'VexaDesktopViewer',
    'VexaMobileViewer',
    'VexaEcgViewer',
    'VexaCaddy'
  )
  retention = [ordered]@{
    keepLast = [int](Get-JsonValue (Get-JsonValue $current 'retention' $null) 'keepLast' 7)
  }
}

if ($null -ne $current -and $current.PSObject.Properties.Name -contains 'schedule') {
  $config.schedule = $current.schedule
} else {
  # Ship an active default schedule in the config file itself so the backup
  # feature is on out of the box (previously enabled=false, so a fresh install
  # had no restore point until someone opened Backup & Restore).
  $config.schedule = [ordered]@{
    enabled = $true
    frequency = 'daily'
    time = '23:00'
    interval = 1
    daysOfWeek = @('MON')
    dayOfMonth = 1
  }
}

function Write-JsonFileNoBom {
  param([string]$Path, $Object, [int]$Depth = 20)
  $json = $Object | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

Write-JsonFileNoBom -Path $configPath -Object $config -Depth 20
Write-Host "Backup config saved: $configPath"
Write-Host "Backup root: $BackupRoot"
Write-Host "DICOM DATA path: $DataDir"
Write-Host "PostgreSQL bin path: $PostgresBinPath"


# Register or refresh the Windows Scheduled Task. Without this the backup
# feature exists but never runs: the config used to ship schedule.enabled=false
# and the task only appeared once someone saved a schedule in the UI, so a fresh
# install had no restore point at all. Failures here must not abort the install.
$scheduleSource = $config.schedule
if ($null -eq $scheduleSource) {
  $scheduleSource = [pscustomobject]@{ enabled = $true; frequency = 'daily'; time = '23:00'; interval = 1; daysOfWeek = @('MON'); dayOfMonth = 1 }
}
$scheduleEnabled = $true
if ($scheduleSource.PSObject.Properties.Name -contains 'enabled') {
  $scheduleEnabled = [bool]$scheduleSource.enabled
}
if ($scheduleEnabled) {
  $registerScript = Join-Path $PSScriptRoot 'register-backup-task.ps1'
  $backupScript = Join-Path $PSScriptRoot 'backup.ps1'
  $frequency = if ($scheduleSource.frequency) { [string]$scheduleSource.frequency } else { 'daily' }
  $time = if ($scheduleSource.time) { [string]$scheduleSource.time } else { '23:00' }
  $interval = if ($scheduleSource.interval) { [int]$scheduleSource.interval } else { 1 }
  $dayOfMonth = if ($scheduleSource.dayOfMonth) { [int]$scheduleSource.dayOfMonth } else { 1 }
  $daysOfWeek = @()
  if ($scheduleSource.daysOfWeek) { $daysOfWeek = @($scheduleSource.daysOfWeek) }

  $taskName = if ($env:VEXA_BACKUP_TASK_NAME) { $env:VEXA_BACKUP_TASK_NAME } else { 'VEXAPACS Daily Backup' }
  if (Test-Path $registerScript) {
    try {
      & $registerScript `
        -TaskName $taskName `
        -BackupScript $backupScript `
        -ConfigPath $configPath `
        -Frequency $frequency `
        -Time $time `
        -Interval $interval `
        -DaysOfWeek $daysOfWeek `
        -DayOfMonth $dayOfMonth
      Write-Host "Backup schedule task is active: $taskName ($frequency at $time)"
    } catch {
      Write-Warning "Cannot register the backup scheduled task: $($_.Exception.Message)"
      Write-Warning "Automatic backup will NOT run until a schedule is saved from the Backup & Restore page."
    }
  } else {
    Write-Warning "Backup task registration script was not found: $registerScript"
  }
} else {
  Write-Host "Backup schedule is disabled in the config; no scheduled task was registered."
}
