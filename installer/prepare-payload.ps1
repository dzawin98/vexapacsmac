param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$PayloadRoot = (Join-Path $PSScriptRoot 'payload'),
  [switch]$SkipBuild,
  [switch]$IncludeNodeModules
)

$ErrorActionPreference = 'Stop'

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Script
  )
  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Script
}

function Copy-Project {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$ExtraExclude = @(),
    [string[]]$ExtraExcludeFiles = @()
  )
  if (Test-Path $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null

  $excludeDirs = @(
    '.git',
    '.next',
    '.vite',
    '.turbo',
    '.cache',
    '.venv',
    'venv',
    '__pycache__',
    'logs',
    'data',
    'DATA',
    'mwl-debug-outbox',
    'keys',
    'Output',
    'payload'
  ) + $ExtraExclude

  if (-not $IncludeNodeModules) {
    $excludeDirs += 'node_modules'
  }

  $excludeFiles = @(
    '.env',
    '*.log',
    '*.err',
    '*.out',
    '*.tmp',
    '*.lic',
    'private*.pem',
    '.env.local'
  ) + $ExtraExcludeFiles

  $robocopyArgs = @(
    $Source,
    $Destination,
    '/E',
    '/NFL',
    '/NDL',
    '/NJH',
    '/NJS',
    '/NP',
    '/XD'
  ) + $excludeDirs + @('public.backup-*') + @('/XF') + $excludeFiles

  & robocopy @robocopyArgs | Out-Null
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "Robocopy failed for $Source -> $Destination with exit code $exitCode"
  }
}

function Require-Command {
  param([string]$Command)
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Command was not found in PATH."
  }
}

function Get-CSharpCompiler {
  $candidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }
  $command = Get-Command csc.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return $null
}

Require-Command node
Require-Command npm

$appPayload = Join-Path $PayloadRoot 'app'
$programDataPayload = Join-Path $PayloadRoot 'programdata'

Invoke-Step "Clean payload" {
  if (Test-Path $PayloadRoot) {
    Remove-Item -LiteralPath $PayloadRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Path $appPayload -Force | Out-Null
  New-Item -ItemType Directory -Path $programDataPayload -Force | Out-Null
}

if (-not $SkipBuild) {
  Invoke-Step "Build VEXA Service Monitor" {
    $source = Join-Path $Root 'tools\service-monitor\VexaServiceMonitor.cs'
    $output = Join-Path $Root 'tools\service-monitor\VexaServiceMonitor.exe'
    $csc = Get-CSharpCompiler
    if (-not $csc) {
      throw "csc.exe was not found. Service Monitor requires the .NET Framework compiler included with Windows."
    }
    & $csc /target:winexe /platform:anycpu /optimize+ /out:$output `
      /reference:System.dll `
      /reference:System.Core.dll `
      /reference:System.Drawing.dll `
      /reference:System.Windows.Forms.dll `
      /reference:System.ServiceProcess.dll `
      $source
    if ($LASTEXITCODE -ne 0) {
      throw "Build VEXA Service Monitor failed with exit code $LASTEXITCODE"
    }
  }

  Invoke-Step "Build RIS frontend" {
    Push-Location (Join-Path $Root 'RIS\frontend')
    npm run build
    Pop-Location
  }

  Invoke-Step "Build PACS" {
    Push-Location (Join-Path $Root 'PACS')
    npm run build
    Pop-Location
  }

  Invoke-Step "Build Primary Diagnostic Viewer UI (5994)" {
    Push-Location (Join-Path $Root 'DESKTOP VIEWER')
    npm run build
    Pop-Location
  }

  Invoke-Step "Build Mobile Viewer" {
    Push-Location (Join-Path $Root 'MOBILITY VIEWER')
    npm run build
    Pop-Location
  }
}

Invoke-Step "Copy modules" {
  Copy-Project `
    -Source (Join-Path $Root 'RIS') `
    -Destination (Join-Path $appPayload 'RIS') `
    -ExtraExclude @((Join-Path $Root 'RIS\frontend\node_modules'))
  Copy-Project -Source (Join-Path $Root 'PACS') -Destination (Join-Path $appPayload 'PACS')
  # Do not exclude "dist" here: several production node packages (including
  # dicom-parser) use a dist directory for their runtime entry point.
  Copy-Project `
    -Source (Join-Path $Root 'DESKTOP VIEWER SSR') `
    -Destination (Join-Path $appPayload 'PRIMARY VIEWER') `
    -ExtraExclude @('src', 'public', '.cache') `
    -ExtraExcludeFiles @('dicom-print-settings.json', '*.tmp')
  Copy-Project `
    -Source (Join-Path $Root 'DESKTOP VIEWER\dist') `
    -Destination (Join-Path $appPayload 'PRIMARY VIEWER\dist')
  Copy-Project `
    -Source (Join-Path $Root 'MOBILITY VIEWER') `
    -Destination (Join-Path $appPayload 'MOBILITY VIEWER') `
    -ExtraExclude @((Join-Path $Root 'MOBILITY VIEWER\node_modules'))
  Copy-Project `
    -Source (Join-Path $Root 'ECG VIEWER') `
    -Destination (Join-Path $appPayload 'ECG VIEWER') `
    -ExtraExclude @((Join-Path $Root 'ECG VIEWER\node_modules'))
  Copy-Project -Source (Join-Path $Root 'scripts') -Destination (Join-Path $appPayload 'scripts') -ExtraExclude @('__pycache__')
  Copy-Project -Source (Join-Path $Root 'tools\backup-agent') -Destination (Join-Path $appPayload 'tools\backup-agent')
  Copy-Project -Source (Join-Path $Root 'tools\simrs-db-bridge') -Destination (Join-Path $appPayload 'tools\simrs-db-bridge')
  Copy-Project -Source (Join-Path $Root 'tools\service-monitor') -Destination (Join-Path $appPayload 'tools\service-monitor')
  # Shared runtime used by the server-rendered primary viewer for its bounded
  # cache and background job queue. It must sit at {app}\tools\runtime because
  # PRIMARY VIEWER\server\index.mjs imports ../../tools/runtime/*.mjs.
  Copy-Project -Source (Join-Path $Root 'tools\runtime') -Destination (Join-Path $appPayload 'tools\runtime')

  # Cine export transcodes WebM -> MP4/AVI/MPEG with ffmpeg. A clean target
  # machine has no ffmpeg on PATH, so the binary ships with the payload and
  # exportRuntime.mjs resolves it next to the server. Without this the viewer
  # offers MP4/AVI/MPEG and then fails at the encode step with an opaque error.
  # NOTE: Copy-Project creates a DIRECTORY, so single binaries use Copy-Item.
  $ffmpegDir = Join-Path $appPayload 'PRIMARY VIEWER\tools\ffmpeg'
  New-Item -ItemType Directory -Path $ffmpegDir -Force | Out-Null
  $ffmpegSource = Join-Path $PSScriptRoot 'vendor\ffmpeg\ffmpeg.exe'
  if (-not (Test-Path -LiteralPath $ffmpegSource)) {
    throw "Bundled ffmpeg is required for cine export: $ffmpegSource (run installer\vendor\fetch-ffmpeg.ps1)"
  }
  Copy-Item -LiteralPath $ffmpegSource -Destination (Join-Path $ffmpegDir 'ffmpeg.exe') -Force
  $ffprobeSource = Join-Path $PSScriptRoot 'vendor\ffmpeg\ffprobe.exe'
  if (Test-Path -LiteralPath $ffprobeSource) {
    Copy-Item -LiteralPath $ffprobeSource -Destination (Join-Path $ffmpegDir 'ffprobe.exe') -Force
  }

  $requiredPrimaryRuntimeFiles = @(
    (Join-Path $appPayload 'PRIMARY VIEWER\server\index.mjs'),
    (Join-Path $appPayload 'PRIMARY VIEWER\node_modules\dicom-parser\dist\dicomParser.min.js'),
    (Join-Path $appPayload 'tools\runtime\cacheStore.mjs'),
    (Join-Path $appPayload 'tools\runtime\jobQueue.mjs'),
    (Join-Path $appPayload 'PRIMARY VIEWER\tools\ffmpeg\ffmpeg.exe')
  )
  foreach ($requiredFile in $requiredPrimaryRuntimeFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
      throw "Primary Viewer installer payload is incomplete: $requiredFile"
    }
  }
}

Invoke-Step "Copy installer runtime scripts" {
  Copy-Project `
    -Source (Join-Path $PSScriptRoot 'scripts') `
    -Destination (Join-Path $appPayload 'installer\scripts') `
    -ExtraExcludeFiles @('fix-viewer-url-rewrite.bat', 'enable-viewer-fix.bat')
}

Invoke-Step "Prepare ProgramData defaults" {
  $publicKeySource = Join-Path $PSScriptRoot 'vendor\license\public.pem'
  if (-not (Test-Path $publicKeySource)) {
    throw "Production license public key is required: $publicKeySource"
  }
  & node -e "require('node:crypto').createPublicKey(require('node:fs').readFileSync(process.argv[1]));" $publicKeySource
  if ($LASTEXITCODE -ne 0) {
    throw "Production license public key is invalid: $publicKeySource"
  }
  Copy-Item -LiteralPath $publicKeySource -Destination (Join-Path $programDataPayload 'public.pem') -Force
}

Write-Host ""
Write-Host "Payload ready: $PayloadRoot" -ForegroundColor Green
if (-not $IncludeNodeModules) {
  Write-Host "Note: node_modules are not included. For offline production, run with -IncludeNodeModules or prepare runtime dependencies separately." -ForegroundColor Yellow
}
