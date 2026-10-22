param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Modules,
  [string]$DataDir = "$env:ProgramData\VEXAPACS\DATA",
  [string]$ProgramDataDir = "$env:ProgramData\VEXAPACS",
  [string]$NodeExe = "node",
  [string]$PythonExe = "python",
  [string]$NssmExe = "",
  [string]$DbHost = "localhost",
  [string]$DbPort = "5432",
  [string]$DbUser = "postgres",
  [string]$DbPass = "velo",
  [string]$RisDbName = "vexaris_db",
  [string]$PacsDbName = "vexapacs_db",
  [string]$LocalHost = "",
  [string]$LocalPort = "80",
  [string]$PublicHost = "",
  [string]$PublicPort = "80",
  [string]$PacsAet = "VEXA",
  [int]$PacsPort = 8889,
  [string]$MwlAet = "VEXARIS",
  [int]$MwlPort = 8887,
  [string]$RamProfile = "standard",
  [switch]$StartServices
)

$ErrorActionPreference = 'Stop'

if (-not $NssmExe) {
  $candidate = Join-Path $InstallDir 'vendor\nssm\nssm.exe'
  if (Test-Path $candidate) {
    $NssmExe = $candidate
  } else {
    $NssmExe = 'nssm'
  }
}

function Require-CommandOrFile {
  param([string]$Value, [string]$Name)
  if (Test-Path $Value) { return }
  if (Get-Command $Value -ErrorAction SilentlyContinue) { return }
  throw "$Name was not found: $Value"
}

function Resolve-Executable {
  param([string]$Value, [string]$Name)
  if (Test-Path $Value) {
    return (Resolve-Path $Value).Path
  }
  $command = Get-Command $Value -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }
  throw "$Name was not found: $Value"
}

function Test-PythonExecutable {
  param([string]$Path)
  if (-not $Path) { return $false }
  try {
    $output = & $Path '--version' 2>&1
    return ($LASTEXITCODE -eq 0 -and ($output -join ' ') -match 'Python')
  } catch {
    return $false
  }
}

function Resolve-PythonExecutable {
  param([string]$Preferred)
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($value in @($Preferred, 'python', 'python3')) {
    if (-not $value) { continue }
    if (Test-Path $value) {
      $candidates.Add((Resolve-Path $value).Path)
      continue
    }
    $command = Get-Command $value -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
      $candidates.Add($command.Source)
    }
  }

  $pyLauncher = Get-Command 'py.exe' -ErrorAction SilentlyContinue
  if ($pyLauncher -and $pyLauncher.Source) {
    try {
      $pyPaths = & $pyLauncher.Source '-0p' 2>$null
      foreach ($line in $pyPaths) {
        if ($line -match '([A-Za-z]:\\.*python\.exe)') {
          $candidates.Add($Matches[1])
        }
      }
    } catch {}
  }

  foreach ($root in @(
    "$env:ProgramFiles\Python*",
    "${env:ProgramFiles(x86)}\Python*",
    "$env:LocalAppData\Programs\Python\Python*"
  )) {
    Get-ChildItem -Path $root -Filter 'python.exe' -ErrorAction SilentlyContinue |
      ForEach-Object { $candidates.Add($_.FullName) }
  }

  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-PythonExecutable $candidate) {
      return $candidate
    }
  }
  throw "Python was not found. Install Python 3 with pip or ensure Python is in PATH."
}

function Has-Module {
  param([string]$Name)
  $set = $Modules.Split(',') | ForEach-Object { $_.Trim().ToUpperInvariant() }
  return $set -contains $Name.ToUpperInvariant()
}

function Service-Exists {
  param([string]$Name)
  return [bool](Get-Service -Name $Name -ErrorAction SilentlyContinue)
}

function Invoke-Nssm {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$Action = "nssm"
  )
  $output = & $NssmExe @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($output) {
    $output | ForEach-Object { Write-Host "[NSSM] $_" }
  }
  if ($exitCode -ne 0) {
    throw "$Action failed with exit code $exitCode. Command: $NssmExe $($Arguments -join ' ')"
  }
}

function Get-LogTail {
  param([string]$Path, [int]$Lines = 30)
  if (-not (Test-Path $Path)) {
    return @()
  }
  try {
    return Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop
  } catch {
    return @("Cannot read log ${Path}: $($_.Exception.Message)")
  }
}

function Start-NssmServiceSafely {
  param([string]$Name)

  Write-Host "[SERVICE] Starting $Name"
  try {
    Invoke-Nssm -Arguments @('start', $Name) -Action "Start service $Name"
  } catch {
    Write-Warning "[SERVICE] $Name did not enter RUNNING state during installer start: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds 2
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Warning "[SERVICE] $Name not found after installation."
    return
  }

  if ($service.Status -ne 'Running') {
    Write-Warning "[SERVICE] $Name status is $($service.Status). Installation will continue; inspect the service log below."
    foreach ($logPath in @(
      (Join-Path $ProgramDataDir "logs\$Name.err.log"),
      (Join-Path $ProgramDataDir "logs\$Name.out.log")
    )) {
      $tail = Get-LogTail -Path $logPath -Lines 30
      if ($tail.Count -gt 0) {
        Write-Warning "[SERVICE] Last lines from $logPath"
        $tail | ForEach-Object { Write-Warning "[SERVICE:$Name] $_" }
      }
    }
  }
}

function Remove-ServiceIfExists {
  param([string]$Name)
  if (-not (Service-Exists $Name)) { return }
  Write-Host "[SERVICE] Removing existing $Name"
  try { Invoke-Nssm -Arguments @('stop', $Name) -Action "Stop service $Name" } catch { Write-Warning $_.Exception.Message }
  Start-Sleep -Seconds 1
  Invoke-Nssm -Arguments @('remove', $Name, 'confirm') -Action "Remove service $Name"
}

function Install-NssmService {
  param(
    [string]$Name,
    [string]$DisplayName,
    [string]$AppDirectory,
    [string]$Executable,
    [string]$Arguments,
    [string[]]$Environment
  )

  Remove-ServiceIfExists $Name
  Write-Host "[SERVICE] Installing $Name"
  Invoke-Nssm -Arguments @('install', $Name, $Executable) -Action "Install service $Name"
  Invoke-Nssm -Arguments @('set', $Name, 'AppParameters', $Arguments) -Action "Set $Name AppParameters"
  Invoke-Nssm -Arguments @('set', $Name, 'DisplayName', $DisplayName) -Action "Set $Name DisplayName"
  Invoke-Nssm -Arguments @('set', $Name, 'AppDirectory', $AppDirectory) -Action "Set $Name AppDirectory"
  Invoke-Nssm -Arguments @('set', $Name, 'Start', 'SERVICE_AUTO_START') -Action "Set $Name startup"
  Invoke-Nssm -Arguments @('set', $Name, 'AppStdout', (Join-Path $ProgramDataDir "logs\$Name.out.log")) -Action "Set $Name stdout"
  Invoke-Nssm -Arguments @('set', $Name, 'AppStderr', (Join-Path $ProgramDataDir "logs\$Name.err.log")) -Action "Set $Name stderr"
  Invoke-Nssm -Arguments @('set', $Name, 'AppRotateFiles', '1') -Action "Set $Name rotate files"
  Invoke-Nssm -Arguments @('set', $Name, 'AppRotateOnline', '1') -Action "Set $Name rotate online"
  Invoke-Nssm -Arguments @('set', $Name, 'AppRotateBytes', '10485760') -Action "Set $Name rotate bytes"
  Invoke-Nssm -Arguments (@('set', $Name, 'AppEnvironmentExtra') + $Environment) -Action "Set $Name environment"
  if (-not (Service-Exists $Name)) {
    throw "Service $Name was not created."
  }
}

$NssmExe = Resolve-Executable $NssmExe 'NSSM'
$NodeExe = Resolve-Executable $NodeExe 'Node.js'
$PythonExe = Resolve-PythonExecutable $PythonExe

New-Item -ItemType Directory -Path $ProgramDataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $ProgramDataDir 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

$envScript = Join-Path $PSScriptRoot 'service-env.ps1'
$commonEnv = & $envScript `
  -InstallDir $InstallDir `
  -DataDir $DataDir `
  -ProgramDataDir $ProgramDataDir `
  -DbHost $DbHost `
  -DbPort $DbPort `
  -DbUser $DbUser `
  -DbPass $DbPass `
  -RisDbName $RisDbName `
  -PacsDbName $PacsDbName `
  -LocalHost $LocalHost `
  -LocalPort $LocalPort `
  -PublicHost $PublicHost `
  -PublicPort $PublicPort `
  -PacsAet $PacsAet `
  -PacsPort $PacsPort `
  -MwlAet $MwlAet `
  -MwlPort $MwlPort

Write-Host "Service installation starting with RAM profile: $RamProfile"

$mprFrameCacheMb = if ($RamProfile -eq 'high') { 2048 } else { 1024 }
$dicomwebFrameCacheMb = if ($RamProfile -eq 'high') { 512 } else { 256 }

if (Has-Module 'RIS') {
  Install-NssmService `
    -Name 'VexaBackupAgent' `
    -DisplayName 'Vexa Backup Agent' `
    -AppDirectory (Join-Path $InstallDir 'tools\backup-agent') `
    -Executable $NodeExe `
    -Arguments 'server.js' `
    -Environment ($commonEnv + @(
      'BACKUP_AGENT_PORT=3099',
      "VEXA_BACKUP_CONFIG_PATH=$ProgramDataDir\backup.config.json",
      "VEXA_BACKUP_SCRIPT_PATH=$InstallDir\installer\scripts\backup\backup.ps1",
      "VEXA_BACKUP_TASK_SCRIPT_PATH=$InstallDir\installer\scripts\backup\register-backup-task.ps1",
      "VEXA_RESTORE_SCRIPT_PATH=$InstallDir\installer\scripts\backup\restore.ps1"
    ))

  Install-NssmService `
    -Name 'VexaSimrsDbBridge' `
    -DisplayName 'Vexa SIMRS DB Bridge' `
    -AppDirectory (Join-Path $InstallDir 'tools\simrs-db-bridge') `
    -Executable $NodeExe `
    -Arguments 'server.js' `
    -Environment ($commonEnv + @(
      'SIMRS_DB_BRIDGE_PORT=3109',
      "VEXA_SETTINGS_PATH=$InstallDir\RIS\backend\settings.json"
    ))

  Install-NssmService `
    -Name 'VexaRISBackend' `
    -DisplayName 'Vexa RIS Backend' `
    -AppDirectory (Join-Path $InstallDir 'RIS\backend') `
    -Executable $NodeExe `
    -Arguments 'index.js' `
    -Environment ($commonEnv + @(
      'PORT=3001',
      "VEXA_BACKUP_SCRIPT_PATH=$InstallDir\installer\scripts\backup\backup.ps1",
      "VEXA_BACKUP_TASK_SCRIPT_PATH=$InstallDir\installer\scripts\backup\register-backup-task.ps1",
      "VEXA_RESTORE_SCRIPT_PATH=$InstallDir\installer\scripts\backup\restore.ps1"
    ))

  Install-NssmService `
    -Name 'VexaRISFrontend' `
    -DisplayName 'Vexa RIS Frontend' `
    -AppDirectory $InstallDir `
    -Executable $NodeExe `
    -Arguments 'installer\scripts\static-server.js --root RIS\frontend\dist --port 8080 --spa true --apiTarget http://127.0.0.1:3001 --backupApiTarget http://127.0.0.1:3099' `
    -Environment ($commonEnv + @('PORT=8080', 'STATIC_BACKUP_API_TARGET=http://127.0.0.1:3099'))
}

if (Has-Module 'PACS_DIMSE') {
  $pacsInternalPort = $PacsPort + 1
  $pacsInternalAetBase = if ($PacsAet.Length -gt 12) { $PacsAet.Substring(0, 12) } else { $PacsAet }
  $pacsInternalAet = "${pacsInternalAetBase}_INT"

  Install-NssmService `
    -Name 'VexaPacsDicomweb' `
    -DisplayName 'Vexa PACS DICOMweb' `
    -AppDirectory (Join-Path $InstallDir 'PACS') `
    -Executable $NodeExe `
    -Arguments 'build\app.js' `
    -Environment ($commonEnv + @(
      'PORT=5001',
      "DICOMWEB_PACS_AET=$PacsAet",
      "DICOMWEB_PACS_DICOM_PORT=$PacsPort",
      'DICOMWEB_DIMSE_STORAGE_COMPRESSION=true',
      'DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX=1.2.840.10008.1.2.4.90',
      "DICOMWEB_FRAME_CACHE_MB=$dicomwebFrameCacheMb",
      "DICOM_STORAGE_PATH=$DataDir",
      "DICOMWEB_PACS_STORAGE_PATH=$DataDir",
      "DICOMWEB_JPEG2000_DECODER_PYTHON=$PythonExe"
    ))

  Install-NssmService `
    -Name 'VexaPacsDimse' `
    -DisplayName 'Vexa PACS DIMSE SCP' `
    -AppDirectory (Join-Path $InstallDir 'PACS') `
    -Executable $PythonExe `
    -Arguments 'scripts\mwl_unified_scp.py' `
    -Environment ($commonEnv + @(
      "DICOMWEB_EXTERNAL_AET=$PacsAet",
      'DICOMWEB_EXTERNAL_HOST=0.0.0.0',
      "DICOMWEB_EXTERNAL_PORT=$PacsPort",
      'DICOMWEB_REQUIRE_CALLED_AET=true',
      "DICOMWEB_INTERNAL_AET=$pacsInternalAet",
      'DICOMWEB_INTERNAL_HOST=127.0.0.1',
      "DICOMWEB_INTERNAL_PORT=$pacsInternalPort",
      "DICOMWEB_PACS_AET=$PacsAet",
      "DICOMWEB_PACS_DICOM_PORT=$PacsPort",
      'DICOMWEB_DIMSE_STORAGE_COMPRESSION=true',
      'DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX=1.2.840.10008.1.2.4.90'
    ))
}

if (Has-Module 'PACS_MWL') {
  Install-NssmService `
    -Name 'VexaMwlService' `
    -DisplayName 'Vexa MWL Service' `
    -AppDirectory (Join-Path $InstallDir 'RIS\backend') `
    -Executable $PythonExe `
    -Arguments 'mwl_scp\vexa_mwl_scp.py' `
    -Environment ($commonEnv + @(
      "MWL_SCP_AET=$MwlAet",
      'MWL_SCP_BIND=0.0.0.0',
      "MWL_SCP_PORT=$MwlPort",
      'MWL_SCP_REQUIRE_CALLED_AET=true',
      'PORT=3001'
    ))
}

if (Has-Module 'DESKTOP_VIEWER') {
  Install-NssmService `
    -Name 'VexaDesktopViewer' `
    -DisplayName 'VEXA Primary Diagnostic Viewer' `
    -AppDirectory (Join-Path $InstallDir 'PRIMARY VIEWER') `
    -Executable $NodeExe `
    -Arguments 'server\index.mjs' `
    -Environment ($commonEnv + @(
      'PORT=5994',
      "VIEWER_DIST_DIR=$InstallDir\PRIMARY VIEWER\dist",
      "NEXIA_AUTH_DB=$ProgramDataDir\viewer-auth-desktop.json",
      "DICOM_PRINT_SETTINGS_PATH=$ProgramDataDir\dicom-print-settings.json",
      "FFMPEG_PATH=$InstallDir\PRIMARY VIEWER\tools\ffmpeg\ffmpeg.exe",
      'NEXIA_SESSION_COOKIE_NAME=vexa_desktop_session',
      'NEXIA_RIS_HEADER_NAME=RIS-Desktop-Sec',
      'VEXA_RIS_SHARED_SECRET=Velodesktopview89287579@#VEXA@',
      'NEXIA_RIS_SHARED_SECRET=Velodesktopview89287579@#VEXA@',
      'NEXIA_RIS_CONSUME_REDIRECT_PATH=/view',
      'NEXIA_RIS_LAUNCH_TTL_SECONDS=60',
      "MPR_FRAME_CACHE_MB=$mprFrameCacheMb"
    ))
}

if (Has-Module 'MOBILE_VIEWER') {
  Install-NssmService `
    -Name 'VexaMobileViewer' `
    -DisplayName 'VEXA MOBILE' `
    -AppDirectory (Join-Path $InstallDir 'MOBILITY VIEWER') `
    -Executable $NodeExe `
    -Arguments 'server\index.mjs' `
    -Environment ($commonEnv + @(
      'PORT=5992',
      "NEXIA_AUTH_DB=$ProgramDataDir\viewer-auth-mobile.json",
      'NEXIA_SESSION_COOKIE_NAME=vexa_mobile_session',
      'NEXIA_RIS_HEADER_NAME=RIS-Vexa-Mobilesec',
      'VEXA_RIS_SHARED_SECRET=Velomobile987397497987#VEXA@',
      'NEXIA_RIS_SHARED_SECRET=Velomobile987397497987#VEXA@',
      'NEXIA_RIS_CONSUME_REDIRECT_PATH=/view',
      'NEXIA_RIS_LAUNCH_TTL_SECONDS=60',
      "MPR_FRAME_CACHE_MB=$mprFrameCacheMb"
    ))
}

if (Has-Module 'ECG_VIEWER') {
  Install-NssmService `
    -Name 'VexaEcgViewer' `
    -DisplayName 'VEXA ECG Viewer' `
    -AppDirectory (Join-Path $InstallDir 'ECG VIEWER') `
    -Executable $NodeExe `
    -Arguments 'server.js' `
    -Environment ($commonEnv + @('ECG_VIEWER_PORT=7771'))
}

if ($StartServices) {
  $serviceNames = @(
    'VexaRISBackend',
    'VexaRISFrontend',
    'VexaBackupAgent',
    'VexaSimrsDbBridge',
    'VexaPacsDicomweb',
    'VexaPacsDimse',
    'VexaMwlService',
    'VexaDesktopViewer',
    'VexaMobileViewer',
    'VexaEcgViewer'
  )
  foreach ($serviceName in $serviceNames) {
    if (Service-Exists $serviceName) {
      Start-NssmServiceSafely -Name $serviceName
    }
  }
}

Write-Host "Service installation complete."
