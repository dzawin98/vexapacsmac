param(
  [string]$InstallDir = "$env:ProgramFiles\VEXAPACS-RIS"
)

$ErrorActionPreference = 'Stop'

$settingsPath = Join-Path $InstallDir 'RIS\backend\settings.json'
if (-not (Test-Path $settingsPath)) {
  throw "settings.json was not found at $settingsPath"
}

$backupPath = "$settingsPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $settingsPath -Destination $backupPath -Force
Write-Host "Backup created: $backupPath" -ForegroundColor Cyan

try {
  $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
} catch {
  Write-Warning "settings.json is invalid, creating minimal new structure."
  $settings = [PSCustomObject]@{}
}

function Set-JsonProperty {
  param($Object, [string]$Name, $Value)
  if ($Object.PSObject.Properties.Name -contains $Name) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

Set-JsonProperty $settings 'pacsViewerEnabled' $true
Set-JsonProperty $settings 'pacsViewerBaseUrl' '/viewer'
Set-JsonProperty $settings 'pacsViewerLaunchEndpoint' '/api/auth/ris/launch'
Set-JsonProperty $settings 'pacsViewerHeaderName' 'RIS-Desktop-Sec'
Set-JsonProperty $settings 'pacsViewerSharedSecret' 'Velodesktopview89287579@#VEXA@'

Set-JsonProperty $settings 'viewers' @(
  [PSCustomObject]@{
    id = 'vexa-pacs'
    name = 'Primary Diagnostic Viewer'
    enabled = $true
    baseUrl = '/viewer'
    internalBaseUrl = 'http://127.0.0.1:5994'
    path = '/Viewer'
    queryParam = 'launch'
    type = 'vexa-ris-launch'
    launchEndpoint = '/api/auth/ris/launch'
    launchHeaderName = 'RIS-Desktop-Sec'
    launchSharedSecret = 'Velodesktopview89287579@#VEXA@'
  },
  [PSCustomObject]@{
    id = 'vexa-mobile'
    name = 'Mobile Viewer'
    enabled = $true
    baseUrl = '/mobile'
    internalBaseUrl = 'http://127.0.0.1:5992'
    path = '/Viewer'
    queryParam = 'launch'
    type = 'vexa-ris-launch'
    launchEndpoint = '/api/auth/ris/launch'
    launchHeaderName = 'RIS-Vexa-Mobilesec'
    launchSharedSecret = 'Velomobile987397497987#VEXA@'
  },
  [PSCustomObject]@{
    id = 'ecg-viewer'
    name = 'VEXA ECG'
    enabled = $true
    baseUrl = '/ecg'
    internalBaseUrl = 'http://127.0.0.1:7771'
    path = '/viewer'
    queryParam = 'StudyInstanceUIDs'
    type = 'url'
    modalityFilter = @('ECG')
  }
)

if (-not $settings.orderOutLinks) {
  Set-JsonProperty $settings 'orderOutLinks' ([PSCustomObject]@{})
}
Set-JsonProperty $settings.orderOutLinks 'urllink1' ([PSCustomObject]@{
  viewerId = 'vexa-pacs'
  role = 'clinician'
  username = 'simrs'
  password = 'simrs'
})
Set-JsonProperty $settings.orderOutLinks 'urllink2' ([PSCustomObject]@{
  viewerId = 'vexa-mobile'
  role = 'clinician'
  username = 'simrs'
  password = 'simrs'
})

$json = $settings | ConvertTo-Json -Depth 50
[IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host 'settings.json fix complete.' -ForegroundColor Green
Write-Host "Location: $settingsPath" -ForegroundColor Cyan

try {
  Restart-Service VexaRISBackend -ErrorAction Stop
  Write-Host 'VexaRISBackend restarted.' -ForegroundColor Green
} catch {
  Write-Warning "Cannot restart VexaRISBackend: $($_.Exception.Message)"
}
