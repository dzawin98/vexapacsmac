param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$ProgramDataDir = "$env:ProgramData\VEXAPACS",
  [string]$DbHost = "localhost",
  [string]$DbPort = "5432",
  [string]$DbUser = "postgres",
  [string]$DbPass = "velo",
  [string]$RisDbName = "vexaris_db",
  [string]$PacsDbName = "vexapacs_db",
  [string]$LocalHost = "",
  [string]$LocalPort = "80",
  [string]$PublicHost = "",
  [string]$PublicPort = "80",
  [string]$PacsAet = "VEXA",
  [int]$PacsPort = 8889,
  [string]$MwlAet = "VEXARIS",
  [int]$MwlPort = 8887
)

$hostValue = $PublicHost.Trim()
if (-not $hostValue) {
  $hostValue = $LocalHost.Trim()
}
$portValue = if ($PublicHost.Trim()) {
  if ($PublicPort.Trim()) { $PublicPort.Trim() } else { "80" }
} else {
  if ($LocalPort.Trim()) { $LocalPort.Trim() } else { "80" }
}
if (-not $hostValue) {
  $hostValue = "localhost"
}
$portSuffix = if ($portValue -eq "80") { "" } else { ":$portValue" }
$scheme = if ($PublicHost.Trim() -and $portValue -eq "443") { "https" } else { "http" }
$publicBaseUrl = "$scheme`://$hostValue$portSuffix"

$common = @(
  "NODE_ENV=production",
  "VEXA_LICENSE_ENFORCE=true",
  "VEXA_LICENSE_FILE=$ProgramDataDir\license.lic",
  "VEXA_LICENSE_PUBLIC_KEY_PATH=$ProgramDataDir\public.pem",
  "DICOM_STORAGE_PATH=$DataDir",
  "DICOMWEB_PACS_STORAGE_PATH=$DataDir",
  "DICOMWEB_PACS_ROOT=http://127.0.0.1:5001",
  "DICOMWEB_RS_ROOT=http://127.0.0.1:5001/rs",
  "DICOMWEB_PACS_AET=$PacsAet",
  "DICOMWEB_PACS_DICOM_HOST=127.0.0.1",
  "DICOMWEB_PACS_DICOM_PORT=$PacsPort",
  "DICOMWEB_REQUIRE_CALLED_AET=true",
  "MWL_SCP_AET=$MwlAet",
  "MWL_SCP_BIND=0.0.0.0",
  "MWL_SCP_PORT=$MwlPort",
  "MWL_SCP_REQUIRE_CALLED_AET=true",
  "PUBLIC_SHARE_BASE_URL=$publicBaseUrl",
  "BACKEND_PUBLIC_BASE_URL=$publicBaseUrl",
  "DB_HOST=$DbHost",
  "DB_PORT=$DbPort",
  "DB_USER=$DbUser",
  "DB_PASS=$DbPass",
  "DB_NAME=$RisDbName",
  "PACS_DB_HOST=$DbHost",
  "PACS_DB_PORT=$DbPort",
  "PACS_DB_USER=$DbUser",
  "PACS_DB_PASS=$DbPass",
  "PACS_DB_NAME=$PacsDbName"
)

return $common
