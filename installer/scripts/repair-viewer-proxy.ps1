param(
  [string]$ProgramDataDir = "$env:ProgramData\VEXAPACS",
  [string]$InstallDir = "$env:ProgramFiles\VEXAPACS-RIS"
)

$ErrorActionPreference = 'Stop'

$caddyfile = Join-Path $ProgramDataDir 'Caddyfile'
$caddyExe = Join-Path $InstallDir 'vendor\caddy\caddy.exe'
if (-not (Test-Path -LiteralPath $caddyfile)) {
  throw "Caddyfile was not found: $caddyfile"
}
if (-not (Test-Path -LiteralPath $caddyExe)) {
  throw "Caddy executable was not found: $caddyExe"
}

$content = Get-Content -LiteralPath $caddyfile -Raw
$updated = $content

# The viewer UI/auth server needs the prefix to keep its React router basename.
# DICOMweb blocks deliberately retain their strip_prefix rules because PACS
# receives its native /rs and /wadouri routes.
$updated = $updated -replace '(?ms)(@viewerAuth\s+path\s+/viewer/api/auth.*?handle\s+@viewerAuth\s*\{\s*)uri\s+strip_prefix\s+/viewer\s*', '$1'
$updated = $updated -replace '(?ms)(@mobileAuth\s+path\s+/mobile/api/auth.*?handle\s+@mobileAuth\s*\{\s*)uri\s+strip_prefix\s+/mobile\s*', '$1'
$updated = $updated.Replace('handle_path /viewer* {', 'handle /viewer* {')
$updated = $updated.Replace('handle_path /mobile* {', 'handle /mobile* {')

if ($updated -eq $content) {
  Write-Host 'Viewer proxy configuration is already current.'
  exit 0
}

$backup = "$caddyfile.backup-viewer-proxy-$(Get-Date -Format 'yyyyMMddHHmmss')"
Copy-Item -LiteralPath $caddyfile -Destination $backup -Force
Set-Content -LiteralPath $caddyfile -Value $updated -Encoding UTF8

try {
  & $caddyExe validate --config $caddyfile --adapter caddyfile
  if ($LASTEXITCODE -ne 0) { throw "Caddy validation failed with exit code $LASTEXITCODE." }
} catch {
  Copy-Item -LiteralPath $backup -Destination $caddyfile -Force
  throw "The proxy change was reverted. $($_.Exception.Message)"
}

Restart-Service -Name 'VexaCaddy' -Force -ErrorAction Stop
Write-Host 'Viewer proxy repaired. Open /viewer/login or /mobile/login, then sign in with an authorized viewer account.'
