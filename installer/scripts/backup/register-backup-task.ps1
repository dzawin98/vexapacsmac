# Registers (or replaces) the VEXAPACS backup Windows Scheduled Task.
#
# Why this exists instead of a plain `schtasks /Create` in the backend:
#   V1.26.18 registered the task with `/RL HIGHEST` and silently fell back to
#   `/RL LIMITED` when that was denied. A LIMITED task is registered as
#   "Interactive only" — it only fires while that user has an open session — so
#   on a headless server the "daily backup" never ran at all. This script
#   registers the task as SYSTEM (runs whether or not anyone is logged on) and,
#   when the caller is not elevated, says so loudly instead of pretending the
#   schedule is active.
#
# Invocation is deliberately `cmd.exe /c` with a pre-quoted command line:
# Windows PowerShell 5.1 does not quote array elements containing spaces when
# calling native commands, so passing the /TR value (`-NoProfile ... -File
# "C:\Program Files\..."`) as an array element makes schtasks reject it with
# "Invalid argument/option - '-NoProfile'".
param(
  [string]$TaskName = "VEXAPACS Daily Backup",
  [Parameter(Mandatory = $true)][string]$BackupScript,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [string]$Frequency = "daily",
  [string]$Time = "23:00",
  [int]$Interval = 1,
  [string[]]$DaysOfWeek = @(),
  [int]$DayOfMonth = 1,
  [switch]$RemoveOnly
)

$ErrorActionPreference = 'Stop'

function Invoke-CmdLine {
  param([string]$CommandLine)
  # A native command writing to stderr turns into a *terminating* error while
  # $ErrorActionPreference='Stop', so relax it for the probe and restore after.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & cmd.exe /c $CommandLine *>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Remove-ExistingTask {
  param([string]$Name)
  try {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop
    Write-Host "[SCHEDULE] Removed existing task $Name"
    return
  } catch {
  }
  # Legacy task created by schtasks, or no task at all (normal first install).
  $result = Invoke-CmdLine -CommandLine ('schtasks.exe /Delete /TN "' + $Name + '" /F')
  if ($result.ExitCode -eq 0) {
    Write-Host "[SCHEDULE] Removed existing task $Name"
  }
}

function Resolve-TriggerTime {
  param([string]$Value)
  if ($Value -notmatch '^(\d{1,2}):(\d{2})$') {
    throw "Invalid schedule time '$Value'. Expected HH:mm."
  }
  $hour = [int]$Matches[1]
  $minute = [int]$Matches[2]
  if ($hour -gt 23 -or $minute -gt 59) {
    throw "Invalid schedule time '$Value'. Expected HH:mm within 00:00-23:59."
  }
  return '{0:00}:{1:00}' -f $hour, $minute
}

function Get-NormalizedDaysOfWeek {
  $map = @{ MON = 'MON'; TUE = 'TUE'; WED = 'WED'; THU = 'THU'; FRI = 'FRI'; SAT = 'SAT'; SUN = 'SUN' }
  $result = @()
  foreach ($day in @($DaysOfWeek)) {
    # Accept both a bare "MON" and a comma-joined "MON,FRI".
    foreach ($part in (([string]$day).ToUpperInvariant() -split ',')) {
      $token = $part.Trim()
      if ($map.ContainsKey($token)) { $result += $map[$token] }
    }
  }
  return @($result | Select-Object -Unique)
}

function Get-ScheduleArgs {
  param([string]$Time24)
  $freq = $Frequency.Trim().ToLowerInvariant()
  if (@('daily', 'weekly', 'monthly') -notcontains $freq) {
    throw "Invalid frequency '$Frequency'. Expected daily, weekly or monthly."
  }
  $safeInterval = [Math]::Max(1, [Math]::Min(365, $Interval))
  $tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"' + $BackupScript + '\" -ConfigPath \"' + $ConfigPath + '\"'
  $args = '/Create /TN "' + $TaskName + '" /SC ' + $freq.ToUpperInvariant() + ' /ST ' + $Time24 + ' /MO ' + [string]$safeInterval
  if ($freq -eq 'weekly') {
    $days = Get-NormalizedDaysOfWeek
    if ($days.Count -eq 0) { $days = @('MON') }
    $args += ' /D ' + ($days -join ',')
  }
  if ($freq -eq 'monthly') {
    $args += ' /D ' + [string]([Math]::Max(1, [Math]::Min(31, $DayOfMonth)))
  }
  $args += ' /TR "' + $tr + '"'
  return $args
}

function Get-RegisteredTask {
  param([string]$Name)
  return (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)
}

Remove-ExistingTask -Name $TaskName
if ($RemoveOnly) {
  Write-Host "[SCHEDULE] Task $TaskName removed on request."
  exit 0
}

if (-not (Test-Path -LiteralPath $BackupScript)) {
  throw "Backup script was not found: $BackupScript"
}

$time24 = Resolve-TriggerTime -Value $Time
$scheduleArgs = Get-ScheduleArgs -Time24 $time24

# 1) Preferred: run as SYSTEM so the backup fires on a server nobody is logged
#    into. Requires an elevated caller (the installer is elevated).
$registered = $null
$limitedWarning = ''
$errors = @()

$systemResult = Invoke-CmdLine -CommandLine ('schtasks.exe ' + $scheduleArgs + ' /RU SYSTEM /RL HIGHEST /F')
if ($systemResult.ExitCode -eq 0) {
  $registered = 'SYSTEM'
} else {
  $errors += ('SYSTEM: ' + $systemResult.Output.Trim())
  # 2) Fallback: register for the current user without elevation. This yields an
  #    "Interactive only" task that only runs while that user is logged on.
  $limitedResult = Invoke-CmdLine -CommandLine ('schtasks.exe ' + $scheduleArgs + ' /RL LIMITED /F')
  if ($limitedResult.ExitCode -eq 0) {
    $registered = 'LIMITED'
    $limitedWarning = 'Backup schedule terdaftar sebagai task LIMITED (hanya berjalan saat ada user yang login ke server), karena registrasi sebagai SYSTEM ditolak. Jalankan installer sebagai Administrator, atau aktifkan schedule sekali lagi dari halaman Backup & Restore dengan hak Administrator, supaya backup tetap berjalan tanpa perlu login.'
    Write-Warning $limitedWarning
  } else {
    $errors += ('LIMITED: ' + $limitedResult.Output.Trim())
  }
}

if (-not $registered) {
  throw ("Cannot register scheduled task '$TaskName'. " + ($errors -join ' | '))
}

$task = Get-RegisteredTask -Name $TaskName
$info = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue } else { $null }

$result = [ordered]@{
  ok = $true
  taskName = $TaskName
  registeredAs = $registered
  frequency = $Frequency.Trim().ToLowerInvariant()
  time = $time24
  interval = [Math]::Max(1, [Math]::Min(365, $Interval))
  daysOfWeek = @(Get-NormalizedDaysOfWeek)
  dayOfMonth = [Math]::Max(1, [Math]::Min(31, $DayOfMonth))
  state = if ($task) { [string]$task.State } else { '' }
  nextRunTime = if ($info -and $info.NextRunTime) { $info.NextRunTime.ToString('o') } else { '' }
  runAsUser = if ($task) { [string]$task.Principal.UserId } else { '' }
  logonType = if ($task) { [string]$task.Principal.LogonType } else { '' }
  runsWithoutUserLoggedOn = ($registered -eq 'SYSTEM')
  warning = $limitedWarning
}
Write-Host "[SCHEDULE] Task registered as $registered (state=$($result.state), next run=$($result.nextRunTime), runsWithoutUserLoggedOn=$($result.runsWithoutUserLoggedOn))"
$result | ConvertTo-Json -Compress -Depth 5
