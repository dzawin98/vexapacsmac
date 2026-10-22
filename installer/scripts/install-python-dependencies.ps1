param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Modules,
  [string]$PythonExe = "python"
)

$ErrorActionPreference = 'Stop'

function Has-Module {
  param([string]$Name)
  $set = $Modules.Split(',') | ForEach-Object { $_.Trim().ToUpperInvariant() }
  return $set -contains $Name.ToUpperInvariant()
}

function Invoke-PipInstall {
  param([string]$RequirementsPath, [string]$Label)
  if (-not (Test-Path $RequirementsPath)) {
    Write-Host "[PYTHON] Skipping $Label, requirements.txt not found."
    return
  }
  Write-Host "[PYTHON] Installing dependencies for $Label..."
  & $PythonExe '-m' 'pip' 'install' '--disable-pip-version-check' '-r' $RequirementsPath
  if ($LASTEXITCODE -ne 0) {
    throw "pip install failed for $Label with exit code $LASTEXITCODE."
  }
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
  throw "Python was not found. Install Python 3 with pip or include the bundled Python installer."
}

$PythonExe = Resolve-PythonExecutable -Preferred $PythonExe
& $PythonExe '--version' | Out-Host

if (Has-Module 'PACS_MWL') {
  Invoke-PipInstall -RequirementsPath (Join-Path $InstallDir 'RIS\backend\mwl_scp\requirements.txt') -Label 'MWL Service'
}

if (Has-Module 'PACS_DIMSE') {
  Invoke-PipInstall -RequirementsPath (Join-Path $InstallDir 'PACS\requirements-mwl.txt') -Label 'PACS DIMSE compression codecs'
}

if (Has-Module 'DESKTOP_VIEWER') {
  Invoke-PipInstall -RequirementsPath (Join-Path $InstallDir 'PRIMARY VIEWER\server\requirements.txt') -Label 'DICOM Print SCU'
}

Write-Host "[PYTHON] Dependency installation completed."
