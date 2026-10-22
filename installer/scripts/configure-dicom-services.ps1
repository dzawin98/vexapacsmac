param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$PacsAet = "VEXA",
  [int]$PacsPort = 8889
)

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $InstallDir 'PACS\config\default.json'
if (-not (Test-Path $configPath)) {
  Write-Host "PACS configuration not installed; skipping DIMSE internal configuration."
  return
}

$internalPort = $PacsPort + 1
if ($internalPort -gt 65535) {
  throw "PACS DIMSE port must be lower than 65535."
}
$internalAetBase = if ($PacsAet.Length -gt 12) { $PacsAet.Substring(0, 12) } else { $PacsAet }
$internalAet = "${internalAetBase}_INT"

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if (-not $config.source) {
  $config | Add-Member -MemberType NoteProperty -Name source -Value ([pscustomobject]@{})
}

$config.source.aet = $internalAet
$config.source.ip = "127.0.0.1"
$config.source.port = [string]$internalPort
# Written without BOM: PACS/src/utils/config.ts loads this through node-config,
# whose JSON parser rejects a leading UTF-8 BOM (PS 5.1 `Set-Content -Encoding
# UTF8` emits one) and would silently fall back to the bundled defaults.
$json = $config | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PACS DIMSE configured: external $PacsAet`:$PacsPort, internal $internalAet@127.0.0.1:$internalPort"
