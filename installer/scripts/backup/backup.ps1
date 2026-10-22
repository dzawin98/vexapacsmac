param(
  [string]$ConfigPath = "",
  [string]$BackupName = "",
  [switch]$SkipDicomData,
  [switch]$SkipProgramData,
  [switch]$NoStopServices,
  [switch]$NoRetention,
  [long]$JobLogId = 0
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-lib.ps1')

function Invoke-PgDump {
  param(
    [string]$PgDump,
    $Postgres,
    [string]$Database,
    [string]$OutputFile
  )
  if (-not $Database) { return }
  Write-Host "[DB] Backup $Database"
  $env:PGPASSWORD = [string]$Postgres.password
  try {
    & $PgDump `
      '-h' ([string]$Postgres.host) `
      '-p' ([string]$Postgres.port) `
      '-U' ([string]$Postgres.user) `
      '-Fc' `
      '-f' $OutputFile `
      $Database
    if ($LASTEXITCODE -ne 0) {
      throw "pg_dump failed for $Database with exit code $LASTEXITCODE"
    }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

$config = Read-BackupConfig $ConfigPath
$timestamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
if (-not $BackupName) {
  $BackupName = $timestamp
}

$backupRoot = [string]$config.backupRoot
if (-not $backupRoot) {
  throw "backupRoot is required in backup.config.json"
}

$backupPath = Join-Path $backupRoot $BackupName
$dbPath = Join-Path $backupPath 'db'
$dataPath = Join-Path $backupPath 'data'
$programDataBackupPath = Join-Path $backupPath 'programdata'

if (-not $JobLogId) {
  $JobLogId = New-BackupJobLog -Config $config -Type 'backup' -BackupPath $backupPath
}

Write-JobProgress -Percent 5 -Message "Preparing backup folder"
Update-BackupJobLog -Config $config -JobLogId $JobLogId -Status 'running' -ExitCode 0 -ProgressPercent 5 -ProgressMessage 'Preparing backup folder'
Ensure-Directory $backupPath
Ensure-Directory $dbPath

$stoppedServices = @()
try {
  if (-not $NoStopServices) {
    Write-JobProgress -Percent 8 -Message "Stopping services temporarily"
    $stoppedServices = Stop-VeloServices $config
  } else {
    Write-JobProgress -Percent 8 -Message "Backing up without stopping services"
  }

  $postgres = $config.postgres
  Test-PostgresConnection -Postgres $postgres -Database 'postgres'
  $pgDump = Resolve-Tool -Name 'pg_dump' -BinPath ([string]$postgres.binPath)
  Write-JobProgress -Percent 15 -Message "Backing up RIS database"
  Update-BackupJobLog -Config $config -JobLogId $JobLogId -Status 'running' -ExitCode 0 -ProgressPercent 15 -ProgressMessage 'Backing up RIS database'
  Invoke-PgDump -PgDump $pgDump -Postgres $postgres -Database ([string]$postgres.risDb) -OutputFile (Join-Path $dbPath 'veloris_db.dump')
  Write-JobProgress -Percent 30 -Message "Backing up PACS database"
  Update-BackupJobLog -Config $config -JobLogId $JobLogId -Status 'running' -ExitCode 0 -ProgressPercent 30 -ProgressMessage 'Backing up PACS database'
  Invoke-PgDump -PgDump $pgDump -Postgres $postgres -Database ([string]$postgres.pacsDb) -OutputFile (Join-Path $dbPath 'velopacs_db.dump')

  $includeDicom = ($config.includeDicomData -ne $false) -and (-not $SkipDicomData)
  if ($includeDicom) {
    Write-JobProgress -Percent 45 -Message "Copying DICOM DATA"
    Update-BackupJobLog -Config $config -JobLogId $JobLogId -Status 'running' -ExitCode 0 -ProgressPercent 45 -ProgressMessage 'Copying DICOM DATA'
    Write-Host "[DATA] Backup DICOM DATA"
    Invoke-RobocopyMirror -Source ([string]$config.dataPath) -Destination $dataPath
  } else {
    Write-JobProgress -Percent 65 -Message "Skip DICOM DATA"
  }

  $includeProgramData = ($config.includeProgramData -ne $false) -and (-not $SkipProgramData)
  if ($includeProgramData) {
    Write-JobProgress -Percent 70 -Message "Copying ProgramData"
    Update-BackupJobLog -Config $config -JobLogId $JobLogId -Status 'running' -ExitCode 0 -ProgressPercent 70 -ProgressMessage 'Copying ProgramData'
    Write-Host "[PROGRAMDATA] Backup ProgramData"
    Invoke-RobocopyMirror -Source ([string]$config.programDataPath) -Destination $programDataBackupPath
    $logsPath = Join-Path $programDataBackupPath 'logs'
    if (Test-Path $logsPath) {
      Remove-Item -LiteralPath $logsPath -Recurse -Force
    }
  } else {
    Write-JobProgress -Percent 82 -Message "Skip ProgramData"
  }

  Write-JobProgress -Percent 90 -Message "Writing backup manifest"
  $manifest = [ordered]@{
    backupVersion = '1.0'
    createdAt = (Get-Date).ToString('o')
    backupName = $BackupName
    machineName = $env:COMPUTERNAME
    dataPath = [string]$config.dataPath
    programDataPath = [string]$config.programDataPath
    includeDicomData = $includeDicom
    includeProgramData = $includeProgramData
    databases = [ordered]@{
      ris = [string]$postgres.risDb
      pacs = [string]$postgres.pacsDb
    }
    stoppedServices = @($stoppedServices)
    config = ConvertTo-Hashtable $config
  }
  Write-Manifest -Path (Join-Path $backupPath 'manifest.json') -Manifest $manifest

  if (-not $NoRetention) {
    Write-JobProgress -Percent 95 -Message "Cleaning old backups based on retention"
    Remove-OldBackups $config
  }

  Write-JobProgress -Percent 100 -Message "Backup completed"
  Update-BackupJobLog -Config $config -JobLogId $JobLogId -Status 'success' -ExitCode 0 -ProgressPercent 100 -ProgressMessage 'Backup completed'
  Write-Host ""
  Write-Host "Backup completed: $backupPath" -ForegroundColor Green
} catch {
  Update-BackupJobLog -Config $config -JobLogId $JobLogId -Status 'failed' -ExitCode 1 -ProgressPercent 0 -ProgressMessage ($_.Exception.Message)
  throw
} finally {
  if ($stoppedServices.Count -gt 0) {
    Start-VeloServices $stoppedServices
  }
}
