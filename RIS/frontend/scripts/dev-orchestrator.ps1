param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$BuildRoot = (Resolve-Path (Join-Path $Root "..")).Path
$WorkspaceRoot = (Resolve-Path (Join-Path $BuildRoot "..")).Path
$RisRoot = $Root
$BackendRoot = Join-Path $BuildRoot "backend"
$DicomWebRoot = Join-Path $WorkspaceRoot "PACS"
$SharedBackendEnv = Join-Path $BuildRoot "backend\.env"
$MwlVenv = Join-Path $BackendRoot "mwl_scp\.venv"
$MwlPython = Join-Path $MwlVenv "Scripts\python.exe"

$global:Processes = @()
$global:Stopping = $false

function Write-DevLine {
  param(
    [string]$Name,
    [string]$Line,
    [ConsoleColor]$Color = [ConsoleColor]::Gray
  )
  if ([string]::IsNullOrWhiteSpace($Line)) { return }
  $old = [Console]::ForegroundColor
  [Console]::ForegroundColor = $Color
  Write-Host ("[{0}] " -f $Name) -NoNewline
  [Console]::ForegroundColor = $old
  Write-Host $Line
}

function Test-Command {
  param([string]$Command)
  $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Import-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $parts = $line.Split("=", 2)
    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1], "Process")
  }
  Write-DevLine "SETUP" "Loaded shared backend configuration from $Path" DarkCyan
}

function Invoke-Checked {
  param(
    [string]$Label,
    [string]$FileName,
    [string]$Arguments,
    [string]$WorkingDirectory
  )
  Write-DevLine "SETUP" "$Label" Cyan
  $process = Start-Process -FilePath $FileName -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "$Label gagal dengan exit code $($process.ExitCode)."
  }
}

function Ensure-Dependencies {
  if (-not (Test-Command "node")) {
    throw "Node.js tidak ditemukan di PATH."
  }
  if (-not (Test-Command "npm")) {
    throw "npm tidak ditemukan di PATH."
  }

  if (-not (Test-Path (Join-Path $RisRoot "node_modules"))) {
    Invoke-Checked "Install dependency frontend RIS" "cmd.exe" "/c npm install" $RisRoot
  }

  if (-not (Test-Path (Join-Path $BackendRoot "node_modules"))) {
    Invoke-Checked "Install dependency backend RIS" "cmd.exe" "/c npm install" $BackendRoot
  }

  if (-not (Test-Path (Join-Path $DicomWebRoot "node_modules"))) {
    Invoke-Checked "Install dependency dicomweb-pacs" "cmd.exe" "/c npm install" $DicomWebRoot
  }

  if (-not (Test-Path $MwlPython)) {
    $pythonBootstrap = "py"
    $pythonArgs = "-3 -m venv `"$MwlVenv`""
    if (-not (Test-Command "py")) {
      $pythonBootstrap = "python"
      $pythonArgs = "-m venv `"$MwlVenv`""
    }
    Invoke-Checked "Membuat virtualenv MWL SCP" $pythonBootstrap $pythonArgs $RisRoot
  }

  Invoke-Checked "Install dependency Python MWL SCP" $MwlPython "-m pip install -r `"$BackendRoot\mwl_scp\requirements.txt`"" $RisRoot

  $pythonCmd = if (Test-Command "py") { "py" } else { "python" }
  $pythonArgs = if ($pythonCmd -eq "py") { "-3 -m pip install -r requirements-mwl.txt" } else { "-m pip install -r requirements-mwl.txt" }
  Invoke-Checked "Install dependency Python DIMSE dicomweb-pacs" $pythonCmd $pythonArgs $DicomWebRoot
}

function New-DevProcess {
  param(
    [string]$Name,
    [string]$Command,
    [string]$WorkingDirectory,
    [ConsoleColor]$Color
  )

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/d /s /c `"$Command`""
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  $process.EnableRaisingEvents = $true

  $outAction = {
    if ($EventArgs.Data) {
      $old = [Console]::ForegroundColor
      [Console]::ForegroundColor = $Event.MessageData.Color
      Write-Host ("[{0}] " -f $Event.MessageData.Name) -NoNewline
      [Console]::ForegroundColor = $old
      Write-Host $EventArgs.Data
    }
  }
  $errAction = {
    if ($EventArgs.Data) {
      $old = [Console]::ForegroundColor
      [Console]::ForegroundColor = [ConsoleColor]::Red
      Write-Host ("[{0}] " -f $Event.MessageData.Name) -NoNewline
      [Console]::ForegroundColor = $old
      Write-Host $EventArgs.Data
    }
  }
  $exitAction = {
    if (-not $global:Stopping) {
      $old = [Console]::ForegroundColor
      [Console]::ForegroundColor = [ConsoleColor]::Yellow
      Write-Host "[SYSTEM] " -NoNewline
      [Console]::ForegroundColor = $old
      Write-Host "$($Event.MessageData.Name) berhenti dengan exit code $($Event.Sender.ExitCode)."
    }
  }

  $null = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action $outAction -MessageData @{ Name = $Name; Color = $Color }
  $null = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action $errAction -MessageData @{ Name = $Name; Color = $Color }
  $null = Register-ObjectEvent -InputObject $process -EventName Exited -Action $exitAction -MessageData @{ Name = $Name; Color = $Color }

  [void]$process.Start()
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()

  [PSCustomObject]@{
    Name = $Name
    Process = $process
  }
}

function Stop-DevProcesses {
  $global:Stopping = $true
  foreach ($entry in $global:Processes) {
    $process = $entry.Process
    if ($process -and -not $process.HasExited) {
      Write-DevLine "SYSTEM" "Stopping $($entry.Name) PID $($process.Id)..." DarkYellow
      & taskkill.exe /PID $process.Id /T /F | Out-Null
    }
  }
  $global:Processes = @()
  $global:Stopping = $false
}

function Stop-StaleWorkspaceProcesses {
  $workspaceRoots = @(
    [Regex]::Escape($RisRoot),
    [Regex]::Escape($BackendRoot),
    [Regex]::Escape($DicomWebRoot)
  )
  $workspacePattern = ($workspaceRoots -join "|")

  $staleProcesses = Get-CimInstance Win32_Process |
    Where-Object {
      $_.ProcessId -ne $PID -and
      $_.CommandLine -and
      (
        (
          $_.CommandLine -match $workspacePattern -and
          (
            $_.CommandLine -match "node\s+index\.js" -or
            $_.CommandLine -match "vite\\bin\\vite\.js" -or
            $_.CommandLine -match "ts-node\\dist\\bin\.js.*src/app\.ts" -or
            $_.CommandLine -match "(vexa|nexia)_mwl_scp\.py"
          )
        ) -or
        $_.CommandLine -match "scripts\\mwl_unified_scp\.py"
      )
    }

  foreach ($stale in $staleProcesses) {
    Write-DevLine "SYSTEM" "Stopping stale workspace process PID $($stale.ProcessId)..." DarkYellow
    & taskkill.exe /PID $stale.ProcessId /T /F | Out-Null
  }

  # The child command line for `node index.js` does not always include the
  # workspace path, so clear the well-known local service ports as a fallback.
  $servicePorts = @(3001, 5001, 5656, 5757, 8889)
  $portOwners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in $servicePorts } |
    Select-Object -ExpandProperty OwningProcess -Unique

  foreach ($ownerPid in $portOwners) {
    if ($ownerPid -and $ownerPid -ne $PID) {
      Write-DevLine "SYSTEM" "Stopping stale listener PID $ownerPid on managed service port..." DarkYellow
      & taskkill.exe /PID $ownerPid /T /F | Out-Null
    }
  }
}

function Wait-TcpPort {
  param(
    [string]$Name,
    [int]$Port,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($listener) {
      Write-DevLine "SYSTEM" "$Name ready on port $Port." DarkGreen
      return
    }
    Start-Sleep -Milliseconds 250
  }

  throw "$Name tidak siap pada port $Port setelah $TimeoutSeconds detik."
}

function Start-DevProcesses {
  Stop-StaleWorkspaceProcesses

  $dimseCommand = if (Test-Command "py") { "py -3 scripts\mwl_unified_scp.py" } else { "python scripts\mwl_unified_scp.py" }

  $global:Processes = @(
    (New-DevProcess "BACKEND" "node index.js" $BackendRoot Green),
    (New-DevProcess "DICOMWEB" "npm start" $DicomWebRoot Cyan),
    (New-DevProcess "DIMSE" $dimseCommand $DicomWebRoot Blue),
    (New-DevProcess "MWL" "`"$MwlPython`" `"$BackendRoot\mwl_scp\vexa_mwl_scp.py`"" $RisRoot Yellow)
  )

  Wait-TcpPort "BACKEND" 3001
  Wait-TcpPort "DICOMWEB" 5001
  Wait-TcpPort "PACS DIMSE" 5757
  Wait-TcpPort "MWL SCP" 5656

  $global:Processes += (New-DevProcess "FRONTEND" "npm run dev" $RisRoot Magenta)
}

function Show-Header {
  Clear-Host
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host " NEXIA PACS RIS development launcher" -ForegroundColor Cyan
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host " Frontend  : http://localhost:8080" -ForegroundColor Gray
  Write-Host " Backend   : backend/.env PORT" -ForegroundColor Gray
  Write-Host " DICOMWEB  : http://127.0.0.1:5001" -ForegroundColor Gray
  Write-Host " PACS DIMSE: AET NEXIA, port 5757" -ForegroundColor Gray
  Write-Host " MWL SCP   : AET NEXIARIS, port 5656" -ForegroundColor Gray
  Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
  Write-Host " Ctrl+R = restart semua service    Ctrl+C = stop/exit" -ForegroundColor Yellow
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host ""
}

try {
  Show-Header
  Import-DotEnv $SharedBackendEnv
  Ensure-Dependencies
  Start-DevProcesses

  while ($true) {
    Start-Sleep -Milliseconds 150

    if (-not [Console]::IsInputRedirected -and [Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      if ($key.Modifiers -band [ConsoleModifiers]::Control -and $key.Key -eq [ConsoleKey]::R) {
        Write-DevLine "SYSTEM" "Ctrl+R diterima. Restart semua service..." Yellow
        Stop-DevProcesses
        Start-Sleep -Milliseconds 700
        Show-Header
        Start-DevProcesses
      }
    }
  }
}
finally {
  Stop-DevProcesses
  Get-EventSubscriber | Where-Object { $_.SourceObject -is [System.Diagnostics.Process] } | Unregister-Event -ErrorAction SilentlyContinue
}
