$ErrorActionPreference = 'Stop'

function Get-DefaultConfigPath {
  return Join-Path $env:ProgramData 'VEXAPACS\backup.config.json'
}

function Read-BackupConfig {
  param([string]$ConfigPath = "")
  if (-not $ConfigPath) {
    $ConfigPath = Get-DefaultConfigPath
  }
  if (-not (Test-Path $ConfigPath)) {
    $sample = Join-Path $PSScriptRoot 'backup.config.sample.json'
    throw "Backup config was not found: $ConfigPath. Copy the sample from $sample"
  }
  # -Encoding UTF8 makes PS 5.1 tolerate a BOM; ConvertFrom-Json would otherwise
  # fail on a config written by an older build of the installer.
  return Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Resolve-Tool {
  param(
    [string]$Name,
    [string]$BinPath = ""
  )
  if ($BinPath) {
    $candidate = Join-Path $BinPath $Name
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
    $candidateExe = Join-Path $BinPath "$Name.exe"
    if (Test-Path $candidateExe) {
      return (Resolve-Path $candidateExe).Path
    }
  }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  $commandExe = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
  if ($commandExe) {
    return $commandExe.Source
  }

  $programFilesRoots = @()
  if ($env:ProgramFiles) {
    $programFilesRoots += (Join-Path $env:ProgramFiles 'PostgreSQL')
  }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($programFilesX86) {
    $programFilesRoots += (Join-Path $programFilesX86 'PostgreSQL')
  }

  $candidates = @()
  foreach ($root in $programFilesRoots) {
    if (-not (Test-Path $root)) { continue }

    foreach ($versionDir in Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue) {
      $versionNumber = 0
      [void][int]::TryParse($versionDir.Name, [ref]$versionNumber)

      $serverTool = Join-Path $versionDir.FullName "bin\$Name.exe"
      if (Test-Path $serverTool) {
        $candidates += [pscustomobject]@{
          Path = (Resolve-Path $serverTool).Path
          Version = $versionNumber
          Priority = 0
        }
      }

      $pgAdminTool = Join-Path $versionDir.FullName "pgAdmin 4\runtime\$Name.exe"
      if (Test-Path $pgAdminTool) {
        $candidates += [pscustomobject]@{
          Path = (Resolve-Path $pgAdminTool).Path
          Version = $versionNumber
          Priority = 1
        }
      }
    }
  }

  $detected = $candidates |
    Sort-Object @{ Expression = 'Priority'; Ascending = $true }, @{ Expression = 'Version'; Descending = $true } |
    Select-Object -First 1
  if ($detected) {
    return $detected.Path
  }

  throw "$Name was not found. Fill postgres.binPath in backup.config.json or add PostgreSQL bin to PATH."
}

function Ensure-Directory {
  param([string]$Path)
  $target = [string]$Path
  if (-not $target.Trim()) {
    throw "Backup folder path is empty. Open Backup Configuration and set Backup Root."
  }
  try {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
  } catch {
    $fallback = Join-Path $env:ProgramData 'VEXAPACS\Backup'
    if ($target -ne $fallback) {
      Write-Warning "Cannot create '$target': $($_.Exception.Message)"
      Write-Host "Falling back to ProgramData: $fallback"
      New-Item -ItemType Directory -Path $fallback -Force | Out-Null
      return
    }
    throw "Cannot create or access backup folder '$target'. Choose a writable Backup Root or grant Modify permission for the VEXA service account. Original error: $($_.Exception.Message)"
  }
}

function Write-JobProgress {
  param(
    [int]$Percent,
    [string]$Message
  )
  $safePercent = [Math]::Max(0, [Math]::Min(100, $Percent))
  Write-Host "[PROGRESS] $safePercent $Message"
}

function ConvertTo-SqlLiteral {
  param($Value)
  if ($null -eq $Value) { return 'NULL' }
  $text = [string]$Value
  return "'" + $text.Replace("'", "''") + "'"
}

function Invoke-BackupManagerSql {
  param(
    $Config,
    [string]$Sql,
    [switch]$Scalar
  )
  try {
    $postgres = $Config.postgres
    $psql = Resolve-Tool -Name 'psql' -BinPath ([string]$postgres.binPath)
    $env:PGPASSWORD = [string]$postgres.password
    $args = @(
      '-h', ([string]$postgres.host),
      '-p', ([string]$postgres.port),
      '-U', ([string]$postgres.user),
      '-d', ([string]$postgres.risDb),
      '-tAc', $Sql
    )
    $output = & $psql @args
    if ($LASTEXITCODE -ne 0) { return $null }
    if ($Scalar) { return (($output | Select-Object -First 1) -as [string]).Trim() }
    return $output
  } catch {
    return $null
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Test-PostgresConnection {
  param(
    $Postgres,
    [string]$Database = "postgres"
  )
  $psql = Resolve-Tool -Name 'psql' -BinPath ([string]$Postgres.binPath)
  $env:PGPASSWORD = [string]$Postgres.password
  try {
    & $psql `
      '-h' ([string]$Postgres.host) `
      '-p' ([string]$Postgres.port) `
      '-U' ([string]$Postgres.user) `
      '-d' $Database `
      '-v' 'ON_ERROR_STOP=1' `
      '-tAc' 'SELECT 1;' | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "PostgreSQL authentication failed for user '$($Postgres.user)' on $($Postgres.host):$($Postgres.port). Check postgres.password in backup.config.json."
    }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Ensure-BackupManagerDbTables {
  param($Config)
  Invoke-BackupManagerSql -Config $Config -Sql @"
CREATE TABLE IF NOT EXISTS backup_job_logs (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  job_type VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  backup_path VARCHAR(1000) NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  exit_code INT NULL,
  progress_percent INT NULL,
  progress_message VARCHAR(255) NULL,
  output_tail TEXT NULL,
  config_json TEXT NULL,
  requested_by VARCHAR(100) NULL
)
"@ | Out-Null
}

function New-BackupJobLog {
  param(
    $Config,
    [string]$Type,
    [string]$BackupPath,
    [string]$RequestedBy = 'windows-task'
  )
  Ensure-BackupManagerDbTables $Config
  $configJson = ($Config | ConvertTo-Json -Depth 20 -Compress)
  $sql = "INSERT INTO backup_job_logs (job_type, status, backup_path, config_json, requested_by) VALUES ($(ConvertTo-SqlLiteral $Type), 'running', $(ConvertTo-SqlLiteral $BackupPath), $(ConvertTo-SqlLiteral $configJson), $(ConvertTo-SqlLiteral $RequestedBy)) RETURNING id"
  $id = Invoke-BackupManagerSql -Config $Config -Sql $sql -Scalar
  if ($id -match '^\d+$') { return [int64]$id }
  return 0
}

function Update-BackupJobLog {
  param(
    $Config,
    [long]$JobLogId,
    [string]$Status,
    [int]$ExitCode,
    [int]$ProgressPercent,
    [string]$ProgressMessage
  )
  if (-not $JobLogId) { return }
  $finished = if ($Status -eq 'running') { 'NULL' } else { 'CURRENT_TIMESTAMP' }
  $sql = "UPDATE backup_job_logs SET status = $(ConvertTo-SqlLiteral $Status), finished_at = $finished, exit_code = $ExitCode, progress_percent = $ProgressPercent, progress_message = $(ConvertTo-SqlLiteral $ProgressMessage) WHERE id = $JobLogId"
  Invoke-BackupManagerSql -Config $Config -Sql $sql | Out-Null
}

function Get-ServiceList {
  param($Config)
  if ($Config.services -and $Config.services.Count -gt 0) {
    return @($Config.services)
  }
  return @(
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
}

function Stop-VeloServices {
  param($Config)
  $stopped = @()
  foreach ($serviceName in (Get-ServiceList $Config)) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $service) { continue }
    if ($service.Status -eq 'Running') {
      Write-Host "[SERVICE] Stop $serviceName"
      Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
      $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
      $stopped += $serviceName
    }
  }
  return $stopped
}

function Start-VeloServices {
  param([string[]]$Services)
  foreach ($serviceName in $Services) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $service) { continue }
    Write-Host "[SERVICE] Start $serviceName"
    Start-Service -Name $serviceName -ErrorAction SilentlyContinue
  }
}

function ConvertTo-Hashtable {
  param($Object)
  if ($null -eq $Object) { return $null }
  if ($Object -is [string]) { return $Object }
  if ($Object -is [ValueType]) { return $Object }
  if ($Object -is [System.Collections.IEnumerable] -and $Object -isnot [string] -and $Object -isnot [pscustomobject]) {
    return @($Object | ForEach-Object { ConvertTo-Hashtable $_ })
  }
  if ($Object -is [pscustomobject]) {
    $hash = [ordered]@{}
    foreach ($property in $Object.PSObject.Properties) {
      $hash[$property.Name] = ConvertTo-Hashtable $property.Value
    }
    return $hash
  }
  return $Object
}

function Write-Manifest {
  param(
    [string]$Path,
    [hashtable]$Manifest
  )
  $tempPath = "$Path.tmp"
  $json = $Manifest | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($tempPath, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

function Read-Manifest {
  param([string]$BackupPath)
  $manifestPath = Join-Path $BackupPath 'manifest.json'
  if (-not (Test-Path $manifestPath)) {
    throw "manifest.json was not found in backup: $BackupPath"
  }
  return Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Invoke-RobocopyMirror {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (-not (Test-Path $Source)) {
    Write-Warning "Source was not found, skipping: $Source"
    return
  }
  Ensure-Directory $Destination
  & robocopy $Source $Destination /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "Robocopy failed: $Source -> $Destination, exit code $exitCode"
  }
}

function Remove-OldBackups {
  param($Config)
  $keepLast = 0
  if ($Config.retention -and $null -ne $Config.retention.keepLast) {
    $keepLast = [int]$Config.retention.keepLast
  }
  if ($keepLast -le 0) { return }
  $backupRoot = [string]$Config.backupRoot
  if (-not (Test-Path $backupRoot)) { return }
  $backups = Get-ChildItem -LiteralPath $backupRoot -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } |
    Sort-Object Name -Descending
  $oldBackups = $backups | Select-Object -Skip $keepLast
  foreach ($backup in $oldBackups) {
    Write-Host "[RETENTION] Remove old backup $($backup.FullName)"
    Remove-Item -LiteralPath $backup.FullName -Recurse -Force
  }
}
