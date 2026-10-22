$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

function Start-DevServer {
  Write-Host ''
  Write-Host 'Starting VEXA Desktop Viewer SSR dev server on port 5994...' -ForegroundColor Cyan
  Write-Host 'Press Ctrl+R in this terminal to restart. Press Ctrl+C to stop.' -ForegroundColor DarkGray

  return Start-Process `
    -FilePath 'npm.cmd' `
    -ArgumentList @('run', 'dev') `
    -NoNewWindow `
    -PassThru
}

function Stop-DevServer($process) {
  if ($null -eq $process -or $process.HasExited) {
    return
  }

  Write-Host ''
  Write-Host 'Restarting dev server...' -ForegroundColor Yellow
  & taskkill.exe /PID $process.Id /T /F | Out-Null
  Start-Sleep -Milliseconds 700
}

$devProcess = Start-DevServer

try {
  while ($true) {
    if ($devProcess.HasExited) {
      exit $devProcess.ExitCode
    }

    if ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      $isCtrlR = (($key.Modifiers -band [ConsoleModifiers]::Control) -ne 0) -and $key.Key -eq [ConsoleKey]::R

      if ($isCtrlR) {
        Stop-DevServer $devProcess
        $devProcess = Start-DevServer
      }
    }

    Start-Sleep -Milliseconds 100
  }
}
finally {
  Stop-DevServer $devProcess
}
