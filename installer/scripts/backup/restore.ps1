param(
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [string]$ConfigPath = "",
  [switch]$ConfirmRestore,
  [switch]$SkipDatabase,
  [switch]$SkipDicomData,
  [switch]$SkipProgramData,
  [switch]$NoStopServices,
  [switch]$NoStartServices
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-lib.ps1')

function Invoke-PgRestore {
  param(
    [string]$PgRestore,
    [string]$Psql,
    $Postgres,
    [string]$Database,
    [string]$DumpFile
  )
  if (-not $Database -or -not (Test-Path $DumpFile)) { return }
  if ($Database -notmatch '^[A-Za-z0-9_]+$') {
    throw "Database name is not valid for automatic restore: $Database"
  }
  Write-Host "[DB] Restore $Database"
  $env:PGPASSWORD = [string]$Postgres.password
  try {
    & $Psql `
      '-h' ([string]$Postgres.host) `
      '-p' ([string]$Postgres.port) `
      '-U' ([string]$Postgres.user) `
      '-d' 'postgres' `
      '-c' "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$Database' AND pid <> pg_backend_pid();"
    if ($LASTEXITCODE -ne 0) {
      throw "psql failed to terminate connections for $Database with exit code $LASTEXITCODE"
    }

    & $Psql `
      '-h' ([string]$Postgres.host) `
      '-p' ([string]$Postgres.port) `
      '-U' ([string]$Postgres.user) `
      '-d' 'postgres' `
      '-c' "DROP DATABASE IF EXISTS `"$Database`";"
    if ($LASTEXITCODE -ne 0) {
      throw "DROP DATABASE failed for $Database with exit code $LASTEXITCODE"
    }

    & $Psql `
      '-h' ([string]$Postgres.host) `
      '-p' ([string]$Postgres.port) `
      '-U' ([string]$Postgres.user) `
      '-d' 'postgres' `
      '-c' "CREATE DATABASE `"$Database`";"
    if ($LASTEXITCODE -ne 0) {
      throw "CREATE DATABASE failed for $Database with exit code $LASTEXITCODE"
    }

    & $PgRestore `
      '-h' ([string]$Postgres.host) `
      '-p' ([string]$Postgres.port) `
      '-U' ([string]$Postgres.user) `
      '-d' $Database `
      '--clean' `
      '--if-exists' `
      $DumpFile
    if ($LASTEXITCODE -ne 0) {
      throw "pg_restore failed for $Database with exit code $LASTEXITCODE"
    }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

if (-not $ConfirmRestore) {
  throw "Restore was cancelled. Add -ConfirmRestore to run restore."
}

if (-not (Test-Path $BackupPath)) {
  throw "BackupPath was not found: $BackupPath"
}

$manifest = Read-Manifest $BackupPath
$config = if ($ConfigPath) {
  Read-BackupConfig $ConfigPath
} else {
  $manifestConfig = $manifest.config
  if ($manifestConfig) { $manifestConfig } else { Read-BackupConfig }
}

$stoppedServices = @()
try {
  if (-not $NoStopServices) {
    Write-JobProgress -Percent 5 -Message "Stopping services temporarily"
    $stoppedServices = Stop-VeloServices $config
  } else {
    Write-JobProgress -Percent 5 -Message "Restoring without stopping services"
    Write-Host "[SERVICE] Skip stop services (-NoStopServices)"
  }

  if (-not $SkipDatabase) {
    $postgres = $config.postgres
    Test-PostgresConnection -Postgres $postgres -Database 'postgres'
    $pgRestore = Resolve-Tool -Name 'pg_restore' -BinPath ([string]$postgres.binPath)
    $psql = Resolve-Tool -Name 'psql' -BinPath ([string]$postgres.binPath)
    Write-JobProgress -Percent 15 -Message "Restore database RIS"
    Invoke-PgRestore -PgRestore $pgRestore -Psql $psql -Postgres $postgres -Database ([string]$postgres.risDb) -DumpFile (Join-Path $BackupPath 'db\veloris_db.dump')
    Write-JobProgress -Percent 40 -Message "Restore database PACS"
    Invoke-PgRestore -PgRestore $pgRestore -Psql $psql -Postgres $postgres -Database ([string]$postgres.pacsDb) -DumpFile (Join-Path $BackupPath 'db\velopacs_db.dump')
  } else {
    Write-JobProgress -Percent 45 -Message "Skip database"
  }

  if (-not $SkipDicomData) {
    $sourceData = Join-Path $BackupPath 'data'
    if (Test-Path $sourceData) {
      Write-JobProgress -Percent 60 -Message "Restore DICOM DATA"
      Write-Host "[DATA] Restore DICOM DATA"
      Invoke-RobocopyMirror -Source $sourceData -Destination ([string]$config.dataPath)
    } else {
      Write-Warning "Backup DICOM DATA was not found, skipping."
    }
  } else {
    Write-JobProgress -Percent 75 -Message "Skip DICOM DATA"
  }

  if (-not $SkipProgramData) {
    $sourceProgramData = Join-Path $BackupPath 'programdata'
    if (Test-Path $sourceProgramData) {
      Write-JobProgress -Percent 82 -Message "Restore ProgramData"
      Write-Host "[PROGRAMDATA] Restore ProgramData"
      Invoke-RobocopyMirror -Source $sourceProgramData -Destination ([string]$config.programDataPath)
    } else {
      Write-Warning "Backup ProgramData was not found, skipping."
    }
  } else {
    Write-JobProgress -Percent 92 -Message "Skip ProgramData"
  }

  Write-JobProgress -Percent 100 -Message "Restore completed"
  Write-Host ""
  Write-Host "Restore completed from: $BackupPath" -ForegroundColor Green
} finally {
  if (-not $NoStartServices -and $stoppedServices.Count -gt 0) {
    Start-VeloServices $stoppedServices
  }
}
