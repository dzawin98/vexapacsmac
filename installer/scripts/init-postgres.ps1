param(
  [string]$DbHost = "localhost",
  [string]$DbPort = "5432",
  [string]$DbUser = "postgres",
  [string]$DbPass = "",
  [string]$RisDbName = "vexaris_db",
  [string]$PacsDbName = "vexapacs_db",
  [string]$PostgresBinPath = ""
)

$ErrorActionPreference = 'Stop'

function Resolve-Tool {
  param([string]$Name, [string]$BinPath = "")
  if ($BinPath) {
    $candidate = Join-Path $BinPath $Name
    if (Test-Path $candidate) { return $candidate }
    $candidateExe = Join-Path $BinPath "$Name.exe"
    if (Test-Path $candidateExe) { return $candidateExe }
  }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $roots = @()
  if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'PostgreSQL') }
  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  if ($programFilesX86) { $roots += (Join-Path $programFilesX86 'PostgreSQL') }
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $match = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "bin\$Name.exe" } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($match) { return $match }
  }
  throw "$Name not found. Install PostgreSQL or add PostgreSQL bin to PATH."
}

function Invoke-Psql {
  param([string]$Sql)
  if ([string]::IsNullOrWhiteSpace($DbPass)) {
    throw "PostgreSQL password is required for user '$DbUser'. Rerun Setup and enter the password configured when PostgreSQL was installed."
  }
  $env:PGPASSWORD = $DbPass
  try {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $output = @(& $psql `
        '-h' $DbHost `
        '-p' $DbPort `
        '-U' $DbUser `
        '-d' 'postgres' `
        '-v' 'ON_ERROR_STOP=1' `
        '-tAc' $Sql 2>&1)
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
      $details = (($output | ForEach-Object { $_.ToString().Trim() }) | Where-Object { $_ }) -join ' | '
      if (-not $details) { $details = 'No diagnostic text was returned by psql.' }
      throw "PostgreSQL connection failed for $DbUser@$DbHost`:$DbPort (psql exit code $exitCode). $details"
    }
    return $output
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }
}

function Quote-PostgresIdentifier {
  param([string]$Value)
  return '"' + ($Value -replace '"', '""') + '"'
}

function Ensure-Database {
  param([string]$DatabaseName)
  if (-not $DatabaseName.Trim()) {
    throw "Database name is required."
  }
  $escaped = $DatabaseName -replace "'", "''"
  $exists = (Invoke-Psql "SELECT 1 FROM pg_database WHERE datname = '$escaped';" | Out-String).Trim()
  if ($exists -eq '1') {
    Write-Host "[DB] Database already exists: $DatabaseName"
    return
  }
  $quoted = Quote-PostgresIdentifier $DatabaseName
  Invoke-Psql "CREATE DATABASE $quoted OWNER $(Quote-PostgresIdentifier $DbUser);"
  Write-Host "[DB] Database created: $DatabaseName"
}

$psql = Resolve-Tool -Name 'psql' -BinPath $PostgresBinPath
Write-Host "[DB] Using psql: $psql"
Invoke-Psql 'SELECT version();' | Out-Null
Ensure-Database -DatabaseName $RisDbName
Ensure-Database -DatabaseName $PacsDbName
Write-Host "[DB] PostgreSQL initialization completed."
