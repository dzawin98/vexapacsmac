param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$LocalHost = "",
  [string]$LocalPort = "80",
  [string]$PublicHost = "",
  [string]$PublicPort = "80",
  [string]$SimrsApiKey = "vexapacs-simrs-local-2026",
  [string]$DesktopViewerSharedSecret = "Velodesktopview89287579@#VEXA@"
)

$ErrorActionPreference = 'Stop'

function Get-BaseUrl {
  $hostValue = $PublicHost.Trim()
  $portValue = if ($PublicPort.Trim()) { $PublicPort.Trim() } else { "80" }
  if (-not $hostValue) {
    $hostValue = $LocalHost.Trim()
    $portValue = if ($LocalPort.Trim()) { $LocalPort.Trim() } else { "80" }
  }
  if (-not $hostValue) {
    $hostValue = "localhost"
  }
  if ($PublicHost.Trim() -and $portValue -eq "443") {
    return "https://$hostValue"
  }
  $portSuffix = if ($portValue -eq "80") { "" } else { ":$portValue" }
  return "http://$hostValue$portSuffix"
}

function Set-JsonProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    $Value
  )
  if ($Object.PSObject.Properties.Name -contains $Name) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  }
}

function Read-JsonFileSafely {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    Write-Warning "Cannot parse existing settings at $Path ($($_.Exception.Message)); values will fall back to the bundled template."
    return $null
  }
}

# Node's JSON.parse rejects a UTF-8 BOM, and readAppLinkSettings() in
# RIS/backend/index.js does a bare readFileSync + JSON.parse. Windows
# PowerShell 5.1 `Set-Content -Encoding UTF8` emits a BOM, which silently
# dropped every configured setting back to defaults after an install.
# Always write JSON for the Node services with this helper.
function Write-JsonFileNoBom {
  param([string]$Path, $Object, [int]$Depth = 20)
  $json = $Object | ConvertTo-Json -Depth $Depth
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Copy-JsonValue {
  param($Source, [string]$Name)
  if ($null -eq $Source) { return $null }
  if (-not ($Source.PSObject.Properties.Name -contains $Name)) { return $null }
  return $Source.$Name
}

$settingsPath = Join-Path $InstallDir 'RIS\backend\settings.json'
if (-not (Test-Path $settingsPath)) {
  Write-Warning "RIS settings was not found: $settingsPath"
  return
}

$publicBaseUrl = Get-BaseUrl
$simrsApiKey = $SimrsApiKey.Trim()
$desktopSharedSecret = $DesktopViewerSharedSecret.Trim()

# Preserve every key the operator already configured. The bundled template is
# only the fallback for keys that do not exist on the server yet, so an upgrade
# can no longer wipe simrsApi (SIMRS API key) or any other site-local setting.
$existingSettings = Read-JsonFileSafely -Path $settingsPath
if ($existingSettings) {
  $backupPath = "$settingsPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  try {
    Copy-Item -LiteralPath $settingsPath -Destination $backupPath -Force
    Write-Host "Existing settings backed up: $backupPath"
  } catch {
    Write-Warning "Cannot back up existing settings: $($_.Exception.Message)"
  }
  $settings = $existingSettings
  $preserved = @()
  foreach ($property in $existingSettings.PSObject.Properties) {
    $existingValue = $property.Value
    if ($null -eq $existingValue) { continue }
    if ($existingValue -is [string] -and -not $existingValue.Trim()) { continue }
    if (-not ($settings.PSObject.Properties.Name -contains $property.Name)) {
      $settings | Add-Member -NotePropertyName $property.Name -NotePropertyValue $existingValue -Force
    }
    $preserved += $property.Name
  }
  Write-Host ("Existing settings preserved: " + ($preserved -join ', '))
} else {
  $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

Set-JsonProperty $settings "publicBaseUrl" $publicBaseUrl

Set-JsonProperty $settings "pacsViewerEnabled" $true
Set-JsonProperty $settings "pacsViewerBaseUrl" "/viewer"
Set-JsonProperty $settings "pacsViewerLaunchEndpoint" "/api/auth/ris/launch"
Set-JsonProperty $settings "pacsViewerHeaderName" "RIS-Desktop-Sec"
Set-JsonProperty $settings "pacsViewerSharedSecret" $desktopSharedSecret

# These two are served at /settings.json on the RIS frontend, and the SIMRS
# middleware reads process.env.SIMRS_API_KEY before settings.simrsApi.apiKey.
# Fill any missing/blank copy so all three read paths resolve, but never
# overwrite a key the operator already configured on this server.
if (-not $settings.simrsApi) {
  $settings | Add-Member -NotePropertyName 'simrsApi' -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not (Copy-JsonValue $settings.simrsApi 'apiKey')) {
  Set-JsonProperty $settings.simrsApi "apiKey" $simrsApiKey
}
if (-not $settings.simrsApi.username) {
  Set-JsonProperty $settings.simrsApi "username" "simrs-integration"
}
if (-not $settings.simrsApi.role) {
  Set-JsonProperty $settings.simrsApi "role" "administrator"
}
if (-not $settings.simrsApi.allowedIps) {
  Set-JsonProperty $settings.simrsApi "allowedIps" @()
}
if ($settings.simrsDbBridge) {
  if (-not $settings.simrsDbBridge.risApi) {
    $settings.simrsDbBridge | Add-Member -NotePropertyName 'risApi' -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if (-not (Copy-JsonValue $settings.simrsDbBridge.risApi 'apiKey')) {
    Set-JsonProperty $settings.simrsDbBridge.risApi "apiKey" $simrsApiKey
  }
}

# Preserve orderOutLinks and simrsDbBridge from existing settings
if ($existingSettings) {
  if (Copy-JsonValue $existingSettings 'orderOutLinks') {
    $settings | Add-Member -NotePropertyName 'orderOutLinks' -NotePropertyValue $existingSettings.orderOutLinks -Force
  }
  if (Copy-JsonValue $existingSettings 'simrsDbBridge') {
    $settings | Add-Member -NotePropertyName 'simrsDbBridge' -NotePropertyValue $existingSettings.simrsDbBridge -Force
  }
}

if (-not $settings.orderOutLinks) {
  $settings | Add-Member -NotePropertyName 'orderOutLinks' -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $settings.orderOutLinks.urllink1) {
  $settings.orderOutLinks | Add-Member -NotePropertyName 'urllink1' -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $settings.orderOutLinks.urllink2) {
  $settings.orderOutLinks | Add-Member -NotePropertyName 'urllink2' -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $settings.orderOutLinks.urllink4) {
  $settings.orderOutLinks | Add-Member -NotePropertyName 'urllink4' -NotePropertyValue ([pscustomobject]@{}) -Force
}
Set-JsonProperty $settings.orderOutLinks.urllink1 "enabled" $true
Set-JsonProperty $settings.orderOutLinks.urllink1 "type" "viewer"
Set-JsonProperty $settings.orderOutLinks.urllink1 "viewerId" "vexa-pacs"
Set-JsonProperty $settings.orderOutLinks.urllink2 "enabled" $true
Set-JsonProperty $settings.orderOutLinks.urllink2 "type" "viewer"
Set-JsonProperty $settings.orderOutLinks.urllink2 "viewerId" "vexa-mobile"
Set-JsonProperty $settings.orderOutLinks.urllink4 "viewerId" "ecg-viewer"

Set-JsonProperty $settings "viewers" @(
  [ordered]@{
    id = "vexa-pacs"
    name = "Primary Diagnostic Viewer"
    baseUrl = "/viewer"
    internalBaseUrl = "http://127.0.0.1:5994"
    path = "/Viewer"
    queryParam = "launch"
    type = "vexa-ris-launch"
    launchEndpoint = "/api/auth/ris/launch"
    launchHeaderName = "RIS-Desktop-Sec"
    launchSharedSecret = 'Velodesktopview89287579@#VEXA@'
  },
  [ordered]@{
    id = "vexa-mobile"
    name = "Mobile Viewer"
    baseUrl = "/mobile"
    internalBaseUrl = "http://127.0.0.1:5992"
    path = "/Viewer"
    queryParam = "launch"
    type = "vexa-ris-launch"
    launchEndpoint = "/api/auth/ris/launch"
    launchHeaderName = "RIS-Vexa-Mobilesec"
    launchSharedSecret = 'Velomobile987397497987#VEXA@'
  },
  [ordered]@{
    id = "ecg-viewer"
    name = "VEXA ECG"
    baseUrl = "/ecg"
    internalBaseUrl = "http://127.0.0.1:7771"
    path = "/viewer"
    queryParam = "StudyInstanceUIDs"
    modalityFilter = @("ECG")
  }
)

Write-JsonFileNoBom -Path $settingsPath -Object $settings -Depth 20
Write-Host "Production RIS settings updated for $publicBaseUrl"
Write-Host "Settings written without BOM (Node JSON.parse compatible): $settingsPath"
