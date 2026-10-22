param(
  [string]$EnvPath,
  [int]$DefaultPort = 5656
)

$port = $DefaultPort

if ($EnvPath -and (Test-Path -LiteralPath $EnvPath)) {
  foreach ($line in Get-Content -LiteralPath $EnvPath) {
    if ($line -match '^\s*MWL_SCP_PORT\s*=\s*(\d+)') {
      $port = [int]$matches[1]
      break
    }
  }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $process = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $listener.OwningProcess) -ErrorAction SilentlyContinue
  Write-Host ("ERROR: Port MWL {0} sudah dipakai oleh PID {1} ({2})." -f $port, $listener.OwningProcess, $process.Name)
  Write-Host ("Command: {0}" -f $process.CommandLine)
  Write-Host "Tutup proses tersebut atau ubah MWL_SCP_PORT di backend\.env."
  exit 2
}

Write-Host ("Port MWL {0} tersedia." -f $port)
exit 0
