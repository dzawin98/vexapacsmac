param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Modules,
  [string]$DataDir = "$env:ProgramData\VEXAPACS\DATA",
  [string]$ProgramDataDir = "$env:ProgramData\VEXAPACS",
  [string]$InstallerVersion = "dev",
  [string]$NodeExe = "node",
  [string]$PythonExe = "python",
  [string]$DbHost = "localhost",
  [string]$DbPort = "5432",
  [string]$DbUser = "postgres",
  [string]$DbPass = "velo",
  [string]$RisDbName = "vexaris_db",
  [string]$PacsDbName = "vexapacs_db",
  [string]$PostgresBinPath = "",
  [string]$BackupRoot = "",
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

New-Item -ItemType Directory -Path $ProgramDataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $ProgramDataDir 'logs') -Force | Out-Null
$postInstallLog = Join-Path $ProgramDataDir 'logs\postinstall.log'
$script:TranscriptStarted = $false
try {
  Start-Transcript -Path $postInstallLog -Append -Force | Out-Null
  $script:TranscriptStarted = $true
} catch {
  Write-Warning "Cannot start postinstall transcript: $($_.Exception.Message)"
}

trap {
  Write-Error "[POSTINSTALL FAILED] $($_.Exception.Message)"
  Write-Error $_
  if ($script:TranscriptStarted) {
    try { Stop-Transcript | Out-Null } catch {}
  }
  exit 1
}

function Test-LocalTcpPort {
  param([int]$Port, [int]$TimeoutMs = 750)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $client.EndConnect($connect)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Assert-InstalledViewerServices {
  param([string]$SelectedModules)

  $checks = @()
  if ($SelectedModules -match '(^|,)DESKTOP_VIEWER(,|$)') {
    $checks += [pscustomobject]@{ Name = 'Primary Diagnostic Viewer'; Service = 'VexaDesktopViewer'; Port = 5994 }
  }
  if ($SelectedModules -match '(^|,)MOBILE_VIEWER(,|$)') {
    $checks += [pscustomobject]@{ Name = 'Mobile Viewer'; Service = 'VexaMobileViewer'; Port = 5992 }
  }
  if ($SelectedModules -match '(^|,)ECG_VIEWER(,|$)') {
    $checks += [pscustomobject]@{ Name = 'ECG Viewer'; Service = 'VexaEcgViewer'; Port = 7771 }
  }

  foreach ($check in $checks) {
    $ready = $false
    for ($attempt = 1; $attempt -le 20; $attempt++) {
      if (Test-LocalTcpPort -Port $check.Port) {
        $ready = $true
        break
      }
      if ($attempt -eq 5) {
        $service = Get-Service -Name $check.Service -ErrorAction SilentlyContinue
        if ($service -and $service.Status -ne 'Running') {
          Write-Host "[VIEWER CHECK] Restarting $($check.Service) after initial startup failure."
          try { Start-Service -Name $check.Service -ErrorAction Stop } catch {}
        }
      }
      Start-Sleep -Milliseconds 750
    }
    if (-not $ready) {
      $service = Get-Service -Name $check.Service -ErrorAction SilentlyContinue
      $status = if ($service) { [string]$service.Status } else { 'NotInstalled' }
      throw "$($check.Name) is unavailable on 127.0.0.1:$($check.Port) (service $($check.Service): $status). Check $ProgramDataDir\logs\$($check.Service).err.log."
    }
    Write-Host "[VIEWER CHECK] $($check.Name) is ready on port $($check.Port)."
  }
}

function Assert-RisViewerLaunchGateway {
  param(
    [string]$SelectedModules,
    [string]$GatewayPort = '80'
  )

  $checks = @()
  if ($SelectedModules -match '(^|,)DESKTOP_VIEWER(,|$)') {
    $checks += [pscustomobject]@{ ViewerId = 'vexa-pacs'; Path = '/viewer/Viewer'; Name = 'Primary Diagnostic Viewer' }
  }
  if ($SelectedModules -match '(^|,)MOBILE_VIEWER(,|$)') {
    $checks += [pscustomobject]@{ ViewerId = 'vexa-mobile'; Path = '/mobile/Viewer'; Name = 'Mobile Viewer' }
  }
  if ($checks.Count -eq 0) { return }

  $port = if ([string]::IsNullOrWhiteSpace($GatewayPort)) { '80' } else { $GatewayPort.Trim() }
  $gatewayOrigin = if ($port -eq '80') { 'http://127.0.0.1' } else { "http://127.0.0.1:$port" }
  $headers = @{
    'x-user-role' = 'administrator'
    'x-user-username' = 'admin'
    'x-forwarded-proto' = 'http'
    'x-forwarded-host' = if ($port -eq '80') { '127.0.0.1' } else { "127.0.0.1:$port" }
  }

  foreach ($check in $checks) {
    $payload = @{
      viewerId = $check.ViewerId
      StudyInstanceUID = '1.2.826.0.1.3680043.10.5432.999.1'
      accession = 'INSTALLER-LAUNCH-SMOKE'
      patientId = 'INSTALLER-SMOKE'
      mode = 'stack'
    } | ConvertTo-Json -Compress

    $lastError = $null
    for ($attempt = 1; $attempt -le 20; $attempt++) {
      try {
        $result = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3001/api/viewer/velo/launch' -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 10
        $launchUri = [Uri]$result.launchUrl
        if ($launchUri.AbsolutePath -ne $check.Path -or -not $launchUri.Query.Contains('launch=')) {
          throw "Unexpected launch URL: $($result.launchUrl)"
        }
        $response = Invoke-WebRequest -Uri $result.launchUrl -UseBasicParsing -TimeoutSec 10
        if ($response.StatusCode -ne 200) {
          throw "Gateway returned HTTP $($response.StatusCode) for $($result.launchUrl)"
        }
        Write-Host "[LAUNCH CHECK] $($check.Name) token route is ready: $($launchUri.AbsolutePath)"
        $lastError = $null
        break
      } catch {
        $lastError = $_.Exception.Message
        Start-Sleep -Milliseconds 750
      }
    }
    if ($lastError) {
      throw "$($check.Name) RIS launch gateway check failed: $lastError"
    }
  }
}

Write-Host "VEXAPACS post-install starting..."
Write-Host "InstallDir: $InstallDir"
Write-Host "Modules: $Modules"
Write-Host "DataDir: $DataDir"
Write-Host "Postinstall log: $postInstallLog"

if ($DataDir -match '(^|\s)-[A-Za-z][A-Za-z0-9]*\b' -or $DataDir -match '"') {
  throw "Invalid DATA path received by postinstall: [$DataDir]. Please rerun installer with a normal folder path such as E:\VEXAPACS-DATA."
}
if ($DataDir -match '^[A-Za-z]:$') {
  $DataDir = Join-Path ($DataDir + '\') 'VEXAPACS-DATA'
  Write-Host "Normalized DATA path to: $DataDir"
} elseif ($DataDir -match '^[A-Za-z]:\\$') {
  $DataDir = Join-Path $DataDir 'VEXAPACS-DATA'
  Write-Host "Normalized DATA path to: $DataDir"
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

if (-not [string]::IsNullOrWhiteSpace($BackupRoot)) {
  $BackupRoot = $BackupRoot.Trim().Trim('"')
} else {
  $dataDrive = Split-Path -Qualifier $DataDir
  if ($dataDrive) {
    $BackupRoot = Join-Path ($dataDrive + '\') 'VEXAPACS-Backup'
  } else {
    $BackupRoot = Join-Path $ProgramDataDir 'Backup'
  }
}
Write-Host "BackupRoot: $BackupRoot"

function Test-PythonExecutable {
  param([string]$Path)
  if (-not $Path) { return $false }
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    $output = & $Path '--version' 2>&1
    return ($LASTEXITCODE -eq 0 -and ($output -join ' ') -match 'Python')
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
}

function Get-PythonCandidates {
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

  return $candidates | Where-Object { $_ } | Select-Object -Unique
}

function Resolve-PythonExecutable {
  param([string]$Preferred)
  foreach ($candidate in (Get-PythonCandidates -Preferred $Preferred)) {
    if (Test-PythonExecutable $candidate) {
      return $candidate
    }
  }
  throw "Python was not found. Install Python 3 with pip or include the bundled Python installer."
}

function Install-BundledPythonIfNeeded {
  param([string]$Preferred)
  try {
    return Resolve-PythonExecutable -Preferred $Preferred
  } catch {
    $pythonInstaller = Get-ChildItem -Path (Join-Path $InstallDir 'vendor\python') -Filter 'python-*.exe' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      Select-Object -First 1
    if (-not $pythonInstaller) {
      throw $_
    }

    Write-Host "Python not found. Installing bundled Python: $($pythonInstaller.FullName)"
    $args = @('/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_pip=1', 'Include_launcher=1')
    $process = Start-Process -FilePath $pythonInstaller.FullName -ArgumentList $args -Wait -PassThru
    if (($process.ExitCode -ne 0) -and ($process.ExitCode -ne 3010)) {
      throw "Bundled Python installer failed with exit code $($process.ExitCode)."
    }
    return Resolve-PythonExecutable -Preferred $Preferred
  }
}

$bundledNode = Join-Path $InstallDir 'vendor\node\node.exe'
if (Test-Path $bundledNode) {
  $NodeExe = $bundledNode
  Write-Host "Using bundled Node.js: $NodeExe"
}

$bundledPython = Join-Path $InstallDir 'vendor\python\python.exe'
if (Test-Path $bundledPython) {
  $PythonExe = $bundledPython
  Write-Host "Using bundled Python: $PythonExe"
} else {
  $PythonExe = Install-BundledPythonIfNeeded -Preferred $PythonExe
  Write-Host "Using Python: $PythonExe"
}

$bundledPublicKey = Join-Path $InstallDir 'programdata\public.pem'
$targetPublicKey = Join-Path $ProgramDataDir 'public.pem'
$licenseFile = Join-Path $ProgramDataDir 'license.lic'
if (Test-Path $bundledPublicKey) {
  Copy-Item -LiteralPath $bundledPublicKey -Destination $targetPublicKey -Force
  Write-Host "Public key copied: $targetPublicKey"
} elseif (-not (Test-Path $targetPublicKey)) {
  Write-Warning "public.pem is not available. Place public key at $targetPublicKey before starting production services."
}

& (Join-Path $PSScriptRoot 'configure-production-settings.ps1') `
  -InstallDir $InstallDir `
  -LocalHost $LocalHost `
  -LocalPort $LocalPort `
  -PublicHost $PublicHost `
  -PublicPort $PublicPort

& (Join-Path $PSScriptRoot 'configure-dicom-services.ps1') `
  -InstallDir $InstallDir `
  -PacsAet $PacsAet `
  -PacsPort $PacsPort

& (Join-Path $PSScriptRoot 'generate-install-request.ps1') `
  -InstallDir $InstallDir `
  -Modules $Modules `
  -ProgramDataDir $ProgramDataDir `
  -InstallerVersion $InstallerVersion `
  -NodeExe $NodeExe

if ($StartServices -and -not (Test-Path $licenseFile)) {
  Write-Host "License file not found yet: $licenseFile"
  Write-Host "Showing activation dialog. The dialog can be skipped if license is not ready."
  try {
    $activationScript = Join-Path $PSScriptRoot 'show-license-activation.ps1'
    $activationArgs = @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', "`"$activationScript`"",
      '-InstallDir', "`"$InstallDir`"",
      '-ProgramDataDir', "`"$ProgramDataDir`"",
      '-NodeExe', "`"$NodeExe`""
    )
    $activationProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $activationArgs -WindowStyle Normal -Wait -PassThru
    Write-Host "License activation dialog exited with code $($activationProcess.ExitCode)."
  } catch {
    Write-Warning "License activation dialog failed or was skipped: $($_.Exception.Message)"
  }
}

$startLicensedServices = $StartServices -and (Test-Path $licenseFile)
if ($StartServices -and -not $startLicensedServices) {
  Write-Host "License file still not found: $licenseFile"
  Write-Host "Services will be created with Automatic startup and can be started after license installation."
}

& (Join-Path $PSScriptRoot 'init-postgres.ps1') `
  -DbHost $DbHost `
  -DbPort $DbPort `
  -DbUser $DbUser `
  -DbPass $DbPass `
  -RisDbName $RisDbName `
  -PacsDbName $PacsDbName `
  -PostgresBinPath $PostgresBinPath

& (Join-Path $PSScriptRoot 'install-node-dependencies.ps1') `
  -InstallDir $InstallDir `
  -Modules $Modules `
  -NodeExe $NodeExe

& (Join-Path $PSScriptRoot 'install-python-dependencies.ps1') `
  -InstallDir $InstallDir `
  -Modules $Modules `
  -PythonExe $PythonExe

& (Join-Path $PSScriptRoot 'backup\install-backup-config.ps1') `
  -ProgramDataDir $ProgramDataDir `
  -BackupRoot $BackupRoot `
  -DataDir $DataDir `
  -DbHost $DbHost `
  -DbPort $DbPort `
  -DbUser $DbUser `
  -DbPass $DbPass `
  -RisDbName $RisDbName `
  -PacsDbName $PacsDbName `
  -PostgresBinPath $PostgresBinPath

& (Join-Path $PSScriptRoot 'install-services.ps1') `
  -InstallDir $InstallDir `
  -Modules $Modules `
  -DataDir $DataDir `
  -ProgramDataDir $ProgramDataDir `
  -NodeExe $NodeExe `
  -PythonExe $PythonExe `
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
  -MwlPort $MwlPort `
  -RamProfile $RamProfile `
  -StartServices:$startLicensedServices

& (Join-Path $PSScriptRoot 'install-caddy.ps1') `
  -InstallDir $InstallDir `
  -ProgramDataDir $ProgramDataDir `
  -LocalHost $LocalHost `
  -LocalPort $LocalPort `
  -PublicHost $PublicHost `
  -PublicPort $PublicPort `
  -StartService:$StartServices

if ($startLicensedServices) {
  Assert-InstalledViewerServices -SelectedModules $Modules
  Assert-RisViewerLaunchGateway -SelectedModules $Modules -GatewayPort $LocalPort
}

Write-Host "VEXAPACS post-install completed."
if ($script:TranscriptStarted) {
  Stop-Transcript | Out-Null
  $script:TranscriptStarted = $false
}
