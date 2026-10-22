param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$ProgramDataDir = "$env:ProgramData\VEXAPACS",
  [string]$LocalHost = "",
  [string]$LocalPort = "80",
  [string]$PublicHost = "",
  [string]$PublicPort = "80",
  [string]$CaddyExe = "",
  [string]$NssmExe = "",
  [switch]$StartService
)

$ErrorActionPreference = 'Stop'

if (-not $CaddyExe) {
  $candidate = Join-Path $InstallDir 'vendor\caddy\caddy.exe'
  if (Test-Path $candidate) {
    $CaddyExe = $candidate
  } else {
    $CaddyExe = 'caddy'
  }
}

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

function Service-Exists {
  param([string]$Name)
  return [bool](Get-Service -Name $Name -ErrorAction SilentlyContinue)
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

function Start-NssmServiceAndWait {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$TimeoutSeconds = 60
  )

  try {
    Invoke-Nssm -Arguments @('start', $Name) -Action "Start service $Name"
  } catch {
    # NSSM commonly returns a non-zero process result while Windows is still
    # transitioning the service to Running. The reliable source of truth is
    # Get-Service below; do not abort the installation on this transient state.
    Write-Warning "NSSM returned a start status for $Name. Waiting for the Windows service state..."
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($service -and $service.Status -eq 'Running') {
      Write-Host "[SERVICE] $Name is running."
      return
    }
    if ($service -and $service.Status -eq 'Stopped') {
      break
    }
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)

  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $service) {
    throw "Service $Name was not found after start."
  }

  if ($service.Status -eq 'StartPending') {
    Write-Warning "Service $Name is still StartPending after $TimeoutSeconds seconds. Post-install will continue; check Caddy logs if it does not reach Running."
    return
  }

  if ($service.Status -ne 'Running') {
    $stderr = Join-Path $ProgramDataDir 'logs\VexaCaddy.err.log'
    $hint = if (Test-Path $stderr) { " Check log: $stderr" } else { "" }
    throw "Service $Name failed to start. Current status: $($service.Status).$hint"
  }
}

function New-CaddyAddress {
  param(
    [string]$HostValue,
    [string]$PortValue,
    [switch]$EnableAutomaticHttps
  )
  $hostText = $HostValue.Trim()
  $portText = $PortValue.Trim()
  if (-not $portText) { $portText = "80" }

  if ($hostText -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
    try {
      $hostUri = [Uri]$hostText
      if ($hostUri.Host -eq '0.0.0.0' -or $hostUri.Host -eq '::') {
        $uriPort = if (-not $hostUri.IsDefaultPort) { [string]$hostUri.Port } else { $portText }
        return ":$uriPort"
      }
    } catch {
      throw "Invalid Caddy host address: $hostText"
    }
    return $hostText
  }

  if (-not $hostText -or $hostText -eq "0.0.0.0" -or $hostText -eq "::") {
    return ":$portText"
  }

  if ($EnableAutomaticHttps -and $portText -eq "443") {
    return $hostText
  }

  return "http://$hostText`:$portText"
}

Require-CommandOrFile $CaddyExe 'Caddy'
Require-CommandOrFile $NssmExe 'NSSM'
$CaddyExe = Resolve-Executable $CaddyExe 'Caddy'
$NssmExe = Resolve-Executable $NssmExe 'NSSM'

New-Item -ItemType Directory -Path $ProgramDataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $ProgramDataDir 'logs') -Force | Out-Null

$template = Join-Path $InstallDir 'installer\scripts\Caddyfile.template'
if (-not (Test-Path $template)) {
  throw "Caddyfile template was not found: $template"
}

$caddyfile = Join-Path $ProgramDataDir 'Caddyfile'
$addresses = New-Object System.Collections.Generic.List[string]
$addresses.Add((New-CaddyAddress -HostValue $LocalHost -PortValue $LocalPort))
if ($PublicHost.Trim()) {
  $addresses.Add((New-CaddyAddress -HostValue $PublicHost -PortValue $PublicPort -EnableAutomaticHttps))
}
$siteAddresses = ($addresses | Select-Object -Unique) -join ', '

$templateText = Get-Content -LiteralPath $template -Raw
$templateText.Replace('__SITE_ADDRESSES__', $siteAddresses) | Set-Content -LiteralPath $caddyfile -Encoding UTF8

$serviceName = 'VexaCaddy'
if (Service-Exists $serviceName) {
  Write-Host "[SERVICE] Removing existing $serviceName"
  try { Invoke-Nssm -Arguments @('stop', $serviceName) -Action "Stop service $serviceName" } catch { Write-Warning $_.Exception.Message }
  Start-Sleep -Seconds 1
  Invoke-Nssm -Arguments @('remove', $serviceName, 'confirm') -Action "Remove service $serviceName"
}

Write-Host "[SERVICE] Installing $serviceName"
Invoke-Nssm -Arguments @('install', $serviceName, $CaddyExe) -Action "Install service $serviceName"
Invoke-Nssm -Arguments @('set', $serviceName, 'AppParameters', "run --config `"$caddyfile`" --adapter caddyfile") -Action "Set $serviceName AppParameters"
Invoke-Nssm -Arguments @('set', $serviceName, 'DisplayName', 'Vexa Caddy Reverse Proxy') -Action "Set $serviceName DisplayName"
Invoke-Nssm -Arguments @('set', $serviceName, 'AppDirectory', $ProgramDataDir) -Action "Set $serviceName AppDirectory"
Invoke-Nssm -Arguments @('set', $serviceName, 'Start', 'SERVICE_AUTO_START') -Action "Set $serviceName startup"
Invoke-Nssm -Arguments @('set', $serviceName, 'AppStdout', (Join-Path $ProgramDataDir 'logs\VexaCaddy.out.log')) -Action "Set $serviceName stdout"
Invoke-Nssm -Arguments @('set', $serviceName, 'AppStderr', (Join-Path $ProgramDataDir 'logs\VexaCaddy.err.log')) -Action "Set $serviceName stderr"
Invoke-Nssm -Arguments @('set', $serviceName, 'AppRotateFiles', '1') -Action "Set $serviceName rotate files"
Invoke-Nssm -Arguments @('set', $serviceName, 'AppRotateOnline', '1') -Action "Set $serviceName rotate online"
Invoke-Nssm -Arguments @('set', $serviceName, 'AppRotateBytes', '10485760') -Action "Set $serviceName rotate bytes"
Invoke-Nssm -Arguments (@('set', $serviceName, 'AppEnvironmentExtra') + @(
  "VEXA_LOCAL_HOST=$LocalHost",
  "VEXA_LOCAL_PORT=$LocalPort",
  "VEXA_PUBLIC_HOST=$PublicHost",
  "VEXA_PUBLIC_PORT=$PublicPort"
)) -Action "Set $serviceName environment"

if (-not (Service-Exists $serviceName)) {
  throw "Service $serviceName was not created."
}

if ($StartService) {
  Start-NssmServiceAndWait -Name $serviceName
}

Write-Host "Caddy service installed. Caddyfile: $caddyfile"
Write-Host "Caddy site addresses: $siteAddresses"
