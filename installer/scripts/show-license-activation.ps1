param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$ProgramDataDir = "$env:ProgramData\VEXAPACS",
  [string]$NodeExe = "node"
)

$ErrorActionPreference = 'Stop'

$licenseCli = Join-Path $InstallDir 'scripts\license\license-cli.js'
$requestCodeFile = Join-Path $ProgramDataDir 'install-request.txt'
$requestJsonFile = Join-Path $ProgramDataDir 'install-request.json'
$licenseFile = Join-Path $ProgramDataDir 'license.lic'
$publicKeyFile = Join-Path $ProgramDataDir 'public.pem'

if (Test-Path $licenseFile) {
  Write-Host "License already installed: $licenseFile"
  exit 0
}

if (-not (Test-Path $requestCodeFile) -and -not (Test-Path $requestJsonFile)) {
  Write-Warning "Install request not found. Skip activation dialog."
  exit 0
}

$requestText = if (Test-Path $requestCodeFile) {
  Get-Content $requestCodeFile -Raw
} else {
  Get-Content $requestJsonFile -Raw
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Test-LicenseText {
  param([string]$Text)
  if (-not $Text.Trim()) {
    throw "License code is empty."
  }
  if (-not (Test-Path $publicKeyFile)) {
    throw "public.pem was not found: $publicKeyFile"
  }
  $temp = Join-Path $env:TEMP ("vexa-license-" + [guid]::NewGuid().ToString("N") + ".lic")
  try {
    [IO.File]::WriteAllText($temp, $Text, (New-Object System.Text.UTF8Encoding($false)))
    & $NodeExe $licenseCli verify --license $temp --public-key $publicKeyFile | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "License is not valid for this machine."
    }
    Copy-Item -LiteralPath $temp -Destination $licenseFile -Force
  } finally {
    Remove-Item $temp -Force -ErrorAction SilentlyContinue
  }
}

$form = New-Object Windows.Forms.Form
$form.Text = "VEXA License Activation"
$form.Width = 980
$form.Height = 760
$form.StartPosition = "CenterScreen"
$form.BackColor = [Drawing.Color]::FromArgb(9, 22, 34)
$form.ForeColor = [Drawing.Color]::White
$form.Font = New-Object Drawing.Font("Segoe UI", 10)

$title = New-Object Windows.Forms.Label
$title.Text = "VEXA License Activation"
$title.Font = New-Object Drawing.Font("Segoe UI Semibold", 22)
$title.AutoSize = $true
$title.Left = 24
$title.Top = 18
$form.Controls.Add($title)

$subtitle = New-Object Windows.Forms.Label
$subtitle.Text = "Copy this request code to VEXA License Manager, then paste the signed license code below."
$subtitle.AutoSize = $true
$subtitle.Left = 26
$subtitle.Top = 66
$subtitle.ForeColor = [Drawing.Color]::FromArgb(180, 210, 225)
$form.Controls.Add($subtitle)

$requestLabel = New-Object Windows.Forms.Label
$requestLabel.Text = "License Request Code"
$requestLabel.AutoSize = $true
$requestLabel.Left = 26
$requestLabel.Top = 104
$form.Controls.Add($requestLabel)

$requestBox = New-Object Windows.Forms.TextBox
$requestBox.Multiline = $true
$requestBox.ScrollBars = "Vertical"
$requestBox.ReadOnly = $true
$requestBox.Left = 26
$requestBox.Top = 130
$requestBox.Width = 910
$requestBox.Height = 220
$requestBox.Font = New-Object Drawing.Font("Consolas", 9)
$requestBox.Text = $requestText
$requestBox.BackColor = [Drawing.Color]::FromArgb(20, 42, 54)
$requestBox.ForeColor = [Drawing.Color]::FromArgb(225, 250, 250)
$form.Controls.Add($requestBox)

$copyButton = New-Object Windows.Forms.Button
$copyButton.Text = "Copy Request Code"
$copyButton.Left = 26
$copyButton.Top = 360
$copyButton.Width = 180
$copyButton.Height = 36
$copyButton.Add_Click({
  [Windows.Forms.Clipboard]::SetText($requestBox.Text)
  [Windows.Forms.MessageBox]::Show("Request code copied.", "VEXA License Activation", "OK", "Information") | Out-Null
})
$form.Controls.Add($copyButton)

$openFolderButton = New-Object Windows.Forms.Button
$openFolderButton.Text = "Open ProgramData"
$openFolderButton.Left = 216
$openFolderButton.Top = 360
$openFolderButton.Width = 170
$openFolderButton.Height = 36
$openFolderButton.Add_Click({ Start-Process explorer.exe $ProgramDataDir })
$form.Controls.Add($openFolderButton)

$licenseLabel = New-Object Windows.Forms.Label
$licenseLabel.Text = "Paste License Code"
$licenseLabel.AutoSize = $true
$licenseLabel.Left = 26
$licenseLabel.Top = 418
$form.Controls.Add($licenseLabel)

$licenseBox = New-Object Windows.Forms.TextBox
$licenseBox.Multiline = $true
$licenseBox.ScrollBars = "Vertical"
$licenseBox.Left = 26
$licenseBox.Top = 444
$licenseBox.Width = 910
$licenseBox.Height = 190
$licenseBox.Font = New-Object Drawing.Font("Consolas", 9)
$licenseBox.BackColor = [Drawing.Color]::FromArgb(20, 42, 54)
$licenseBox.ForeColor = [Drawing.Color]::FromArgb(225, 250, 250)
$form.Controls.Add($licenseBox)

$status = New-Object Windows.Forms.Label
$status.Text = "If you do not have a license code yet, click Skip. Services will be created but will not start until license.lic is installed."
$status.AutoSize = $false
$status.Left = 26
$status.Top = 644
$status.Width = 620
$status.Height = 44
$status.ForeColor = [Drawing.Color]::FromArgb(255, 210, 120)
$form.Controls.Add($status)

$skipButton = New-Object Windows.Forms.Button
$skipButton.Text = "Skip"
$skipButton.Left = 684
$skipButton.Top = 650
$skipButton.Width = 110
$skipButton.Height = 40
$skipButton.Add_Click({
  $form.DialogResult = [Windows.Forms.DialogResult]::Cancel
  $form.Close()
})
$form.Controls.Add($skipButton)

$activateButton = New-Object Windows.Forms.Button
$activateButton.Text = "Activate"
$activateButton.Left = 808
$activateButton.Top = 650
$activateButton.Width = 128
$activateButton.Height = 40
$activateButton.BackColor = [Drawing.Color]::FromArgb(0, 180, 170)
$activateButton.ForeColor = [Drawing.Color]::White
$activateButton.Add_Click({
  try {
    Test-LicenseText $licenseBox.Text
    [Windows.Forms.MessageBox]::Show("License successfully activated.`n$licenseFile", "VEXA License Activation", "OK", "Information") | Out-Null
    $form.DialogResult = [Windows.Forms.DialogResult]::OK
    $form.Close()
  } catch {
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, "License activation failed", "OK", "Error") | Out-Null
  }
})
$form.Controls.Add($activateButton)

[void]$form.ShowDialog()
