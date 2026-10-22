#define MyAppName "VEXAPACS-RIS"
#define DefaultRisDb "vexaris_db"
#define DefaultPacsDb "vexapacs_db"
#define MyAppVersion "1.26.29"
#define MyAppPublisher "VEXAPACS"

[Setup]
AppId={{D9054F79-52B4-4A03-B271-0D2E4F4C9B72}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\VEXAPACS-RIS
DefaultGroupName=VEXAPACS-RIS
OutputDir=Output
OutputBaseFilename=VEXAPACS-RIS-Setup-V1.26.29
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\logo.png

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Components]
Name: "ris"; Description: "RIS Frontend + Backend"; Types: full compact custom; Flags: fixed
Name: "pacs_dimse"; Description: "PACS DICOMweb + DIMSE Service"; Types: full custom
Name: "pacs_mwl"; Description: "MWL Service"; Types: full custom
Name: "desktop_viewer"; Description: "Primary Diagnostic Viewer (Server-rendered, port 5994)"; Types: full custom
Name: "mobile_viewer"; Description: "Mobile Viewer"; Types: full custom
Name: "ecg_viewer"; Description: "ECG Viewer"; Types: full custom

[Files]
Source: "payload\app\scripts\*"; DestDir: "{app}\scripts"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\app\tools\*"; DestDir: "{app}\tools"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\app\installer\*"; DestDir: "{app}\installer"; Flags: recursesubdirs createallsubdirs ignoreversion

; Carried inside the installer and extracted to {tmp} at run time. The scripts
; must NOT be loaded from {app}\installer\scripts: on the first upgrade from an
; older version that directory holds OLD scripts which do not have the pre-stop
; logic yet, so the fix would silently not run for exactly the upgrade that
; needs it. dontcopy = never installed, only available to ExtractTemporaryFile.
Source: "payload\app\installer\scripts\stop-vexapacs-services.ps1"; Flags: dontcopy
Source: "payload\app\installer\scripts\start-vexapacs-services.ps1"; Flags: dontcopy

; Bundled ffmpeg for cine export (MP4/AVI/MPEG). It lives under the PRIMARY
; VIEWER payload because exportRuntime.mjs resolves it relative to the viewer
; server, not to {app}\tools.
Source: "payload\app\PRIMARY VIEWER\tools\ffmpeg\ffmpeg.exe"; DestDir: "{app}\PRIMARY VIEWER\tools\ffmpeg"; Flags: ignoreversion
Source: "payload\app\PRIMARY VIEWER\tools\ffmpeg\ffprobe.exe"; DestDir: "{app}\PRIMARY VIEWER\tools\ffmpeg"; Flags: ignoreversion skipifsourcedoesntexist
Source: "payload\programdata\*"; DestDir: "{app}\programdata"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "vendor\*"; DestDir: "{app}\vendor"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist; Excludes: "README.md,license\private*.pem,license\*.lic,ffmpeg,ffmpeg\*"

Source: "payload\app\RIS\*"; DestDir: "{app}\RIS"; Components: ris; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\app\PACS\*"; DestDir: "{app}\PACS"; Check: ShouldInstallPacs; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\app\PRIMARY VIEWER\*"; DestDir: "{app}\PRIMARY VIEWER"; Components: desktop_viewer; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\app\MOBILITY VIEWER\*"; DestDir: "{app}\MOBILITY VIEWER"; Components: mobile_viewer; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\app\ECG VIEWER\*"; DestDir: "{app}\ECG VIEWER"; Components: ecg_viewer; Flags: recursesubdirs createallsubdirs ignoreversion

[Dirs]
Name: "{commonappdata}\VEXAPACS"
Name: "{commonappdata}\VEXAPACS\logs"
Name: "{code:GetDataDir}"

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\scripts\uninstall-services.ps1"""; \
  Flags: runhidden waituntilterminated

[Icons]
Name: "{group}\VEXAPACS Install Request"; Filename: "{commonappdata}\VEXAPACS\install-request.json"
Name: "{group}\VEXAPACS License Request Code"; Filename: "{commonappdata}\VEXAPACS\install-request.txt"
Name: "{group}\VEXAPACS Logs"; Filename: "{commonappdata}\VEXAPACS\logs"
Name: "{group}\VEXAPACS DATA"; Filename: "{code:GetDataDir}"
Name: "{group}\VEXAPACS Backup"; Filename: "{code:GetBackupRoot}"
Name: "{group}\Backup VEXAPACS"; Filename: "{app}\installer\scripts\backup\backup.bat"; WorkingDir: "{app}\installer\scripts\backup"
Name: "{group}\Restore VEXAPACS"; Filename: "{app}\installer\scripts\backup\restore.bat"; WorkingDir: "{app}\installer\scripts\backup"
Name: "{group}\Backup Config"; Filename: "{commonappdata}\VEXAPACS\backup.config.json"
Name: "{group}\VEXA Service Monitor"; Filename: "{app}\tools\service-monitor\VexaServiceMonitor.exe"; WorkingDir: "{app}\tools\service-monitor"

[Code]
var
  RamProfilePage: TInputOptionWizardPage;
  DataDirPage: TInputDirWizardPage;
  BackupDirPage: TInputDirWizardPage;
  AccessEndpointPage: TInputQueryWizardPage;
  DatabaseConnectionPage: TInputQueryWizardPage;
  DatabaseNamesPage: TInputQueryWizardPage;
  DicomServicesPage: TInputQueryWizardPage;
  IsUpgrade: Boolean;
  UpgradeDeclined: Boolean;
  PreviousVersion: String;
  PreviousInstallDir: String;
  InstalledServices: String;
  LiveDataDir: String;
  LiveDataDirKnown: Boolean;
  PreviousKeyRoot: Integer;
  PreviousKeyName: String;
  PreStopListPath: String;
  PreStopRan: Boolean;
  LiveRisDbName: String;
  LivePacsDbName: String;

function UninstallBaseKey: String;
begin
  Result := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall';
end;

function IsVexaUninstallEntry(RootKey: Integer; KeyName: String): Boolean;
var
  Display: String;
begin
  Result := False;
  if not RegQueryStringValue(RootKey, UninstallBaseKey + '\' + KeyName, 'DisplayName', Display) then
    Exit;
  Result := Pos('VEXAPACS-RIS', Uppercase(Display)) > 0;
end;

// Locate the product's uninstall key by ENUMERATING the Uninstall subkeys and
// matching DisplayName. Deriving the name from AppId is not reliable here: this
// AppId starts with "{{", and the literal '{#SetupSetting("AppId")}' expands to
// a name that does not match the key Inno actually wrote. Enumeration also
// avoids the 32/64-bit view problem, because both views are searched explicitly.
function FindVexaUninstallKey: Boolean;
var
  Names: TArrayOfString;
  Index: Integer;
  Roots: array[0..2] of Integer;
  RootIndex: Integer;
begin
  Result := False;
  Roots[0] := HKLM64;
  Roots[1] := HKLM32;
  Roots[2] := HKCU;
  for RootIndex := 0 to 2 do
  begin
    if not RegGetSubkeyNames(Roots[RootIndex], UninstallBaseKey, Names) then
      continue;
    for Index := 0 to GetArrayLength(Names) - 1 do
    begin
      if (Length(Names[Index]) > 4) and
         (Copy(Names[Index], Length(Names[Index]) - 3, 4) = '_is1') and
         IsVexaUninstallEntry(Roots[RootIndex], Names[Index]) then
      begin
        PreviousKeyRoot := Roots[RootIndex];
        PreviousKeyName := Names[Index];
        Result := True;
        Exit;
      end;
    end;
  end;
end;

function GetPreviousVersion: String;
var
  Display: String;
begin
  Result := '';
  if not FindVexaUninstallKey then
    Exit;
  if RegQueryStringValue(PreviousKeyRoot, UninstallBaseKey + '\' + PreviousKeyName, 'DisplayVersion', Display) then
    Result := Display;
end;

function GetPreviousInstallLocation: String;
var
  Location: String;
begin
  Result := '';
  if not FindVexaUninstallKey then
    Exit;
  if RegQueryStringValue(PreviousKeyRoot, UninstallBaseKey + '\' + PreviousKeyName, 'InstallLocation', Location) then
    Result := Location;
end;

// Read a value out of %ProgramData%\VEXAPACS\backup.config.json without a JSON
// parser: the file is pretty-printed with one "key": "value" per line.
function ReadProgramDataJsonString(FileName: String; Key: String): String;
var
  Lines: TArrayOfString;
  ConfigPath: String;
  Index: Integer;
  Line: String;
  Needle: String;
begin
  Result := '';
  ConfigPath := ExpandConstant('{commonappdata}\VEXAPACS\') + FileName;
  if not FileExists(ConfigPath) then
    Exit;
  if not LoadStringsFromFile(ConfigPath, Lines) then
    Exit;
  Needle := '"' + Key + '"';
  for Index := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Trim(Lines[Index]);
    if Pos(Needle, Line) <> 1 then
      continue;
    Line := Trim(Copy(Line, Length(Needle) + 1, Length(Line)));
    if (Length(Line) < 2) or (Line[1] <> ':') then
      continue;
    Line := Trim(Copy(Line, 2, Length(Line)));
    if (Length(Line) >= 2) and (Line[1] = '"') then
    begin
      Line := Copy(Line, 2, Length(Line));
      if (Length(Line) >= 1) and (Line[Length(Line)] = ',') then
        Line := Copy(Line, 1, Length(Line) - 1);
      if (Length(Line) >= 1) and (Line[Length(Line)] = '"') then
        Line := Copy(Line, 1, Length(Line) - 1);
      // JSON escapes a literal backslash as "\\", so a Windows path arrives as
      // D:\\VELOPACS-RIS\\DATA. Collapse the pairs back to single backslashes or
      // the wizard pre-fills an unusable path.
      StringChangeEx(Line, '\\', '\', True);
      Result := Line;
      Exit;
    end;
  end;
end;

// Which VEXAPACS services are actually installed on this machine? This is the
// real signal that an existing installation is present, and it survives even if
// the uninstall registry entry was removed by hand.
function DetectInstalledServices: String;
var
  Names: array[0..9] of String;
  Index: Integer;
begin
  Result := '';
  Names[0] := 'VexaRISBackend';
  Names[1] := 'VexaRISFrontend';
  Names[2] := 'VexaPacsDicomweb';
  Names[3] := 'VexaPacsDimse';
  Names[4] := 'VexaMwlService';
  Names[5] := 'VexaDesktopViewer';
  Names[6] := 'VexaMobileViewer';
  Names[7] := 'VexaEcgViewer';
  Names[8] := 'VexaCaddy';
  Names[9] := 'VexaBackupAgent';
  for Index := 0 to 9 do
  begin
    if RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\' + Names[Index]) then
    begin
      if Result <> '' then
        Result := Result + ', ';
      Result := Result + Names[Index];
    end;
  end;
end;

function HasExistingInstallation: Boolean;
begin
  Result := (GetPreviousVersion <> '') or (DetectInstalledServices <> '') or
    FileExists(ExpandConstant('{commonappdata}\VEXAPACS\backup.config.json'));
end;

function EscapePascalString(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '''', '''''', True);
end;

// Locate an existing installation root by looking for a marker file. Used only
// to read back the database names the server is already running, so an upgrade
// never points the services at a different (empty) database.
function GuessInstalledRoot: String;
var
  Candidates: array[0..3] of String;
  Index: Integer;
begin
  // NOTE: do NOT start from ExpandConstant('{app}') here - it raises
  // "An attempt was made to expand the app constant before it was
  // initialized" when called before the directory page exists.
  Result := '';
  Candidates[0] := PreviousInstallDir;
  Candidates[1] := ExpandConstant('{autopf}\VEXAPACS-RIS');
  Candidates[2] := 'C:\Program Files\VEXAPACS-RIS';
  Candidates[3] := 'D:\VELOPACS-RIS';
  for Index := 0 to 3 do
  begin
    if (Candidates[Index] <> '') and
       FileExists(Candidates[Index] + '\installer\scripts\init-postgres.ps1') then
    begin
      Result := Candidates[Index];
      Exit;
    end;
  end;
end;

// Extract a scalar value from a .ps1 parameter default, e.g.
//   [string]$RisDbName = "vexaris_db",
// Returns '' when the file or parameter is missing.
function ReadPowerShellParamDefault(FilePath: String; ParamName: String): String;
var
  Lines: TArrayOfString;
  Index: Integer;
  Line: String;
  Needle: String;
  Position: Integer;
  Tail: String;
  Value: String;
begin
  Result := '';
  if FileExists(FilePath) then
  begin
    if LoadStringsFromFile(FilePath, Lines) then
    begin
      Needle := '$' + ParamName + ' =';
      for Index := 0 to GetArrayLength(Lines) - 1 do
      begin
        Line := Trim(Lines[Index]);
        // The parameter is declared as `[string]$RisDbName = "vexaris_db",`,
        // so the needle is NOT at position 1 — searching only the start of the
        // line never matches and the resolver silently falls back to the
        // shipped default. Search anywhere in the line.
        Position := Pos(Needle, Line);
        if Position = 0 then
          continue;
        Tail := Trim(Copy(Line, Position + Length(Needle), Length(Line)));
        if (Length(Tail) >= 2) and (Tail[1] = '"') then
        begin
          Value := '';
          Position := 2;
          while (Position <= Length(Tail)) and (Tail[Position] <> '"') do
          begin
            Value := Value + Tail[Position];
            Position := Position + 1;
          end;
          Result := Value;
          Exit;
        end;
      end;
    end;
  end;
  // No name configured on the server: fall back to the shipped default so a
  // FRESH install gets the current naming.
  if ParamName = 'RisDbName' then
    Result := '{#DefaultRisDb}'
  else if ParamName = 'PacsDbName' then
    Result := '{#DefaultPacsDb}';
end;

// Names the server would use if install-services.ps1 ran right now: the live
// value from the installed scripts, then an existing config file, then the
// shipped default.
function ResolveLiveRisDbName: String;
var
  Root: String;
  Value: String;
begin
  Root := GuessInstalledRoot;
  Value := ReadPowerShellParamDefault(Root + '\installer\scripts\init-postgres.ps1', 'RisDbName');
  if Value = '' then
    Value := ReadPowerShellParamDefault(Root + '\installer\scripts\install-services.ps1', 'RisDbName');
  if Value = '' then
    Value := ReadProgramDataJsonString('backup.config.json', 'risDb');
  if Value = '' then
    Value := '{#DefaultRisDb}';
  Result := Value;
end;

function ResolveLivePacsDbName: String;
var
  Root: String;
  Value: String;
begin
  Root := GuessInstalledRoot;
  Value := ReadPowerShellParamDefault(Root + '\installer\scripts\init-postgres.ps1', 'PacsDbName');
  if Value = '' then
    Value := ReadPowerShellParamDefault(Root + '\installer\scripts\install-services.ps1', 'PacsDbName');
  if Value = '' then
    Value := ReadProgramDataJsonString('backup.config.json', 'pacsDb');
  if Value = '' then
    Value := '{#DefaultPacsDb}';
  Result := Value;
end;

// Stop every VEXAPACS service and close the service monitor, then wait until
// they really hold no file handles. Setup copies files during ssInstall and
// would otherwise fail with "DeleteFile failed; code 5. Access is denied." on
// anything still running out of the install directory.
function RunPrestopScript: Boolean;
var
  ResultCode: Integer;
  Params: String;
  ScriptPath: String;
begin
  Result := False;
  ScriptPath := ExpandConstant('{tmp}\stop-vexapacs-services.ps1');
  // ExtractTemporaryFile is a procedure (no return value), so confirm the file
  // actually landed on disk instead of testing its result.
  ExtractTemporaryFile('stop-vexapacs-services.ps1');
  if not FileExists(ScriptPath) then
  begin
    Log('Pre-stop script could not be extracted, skipping.');
    Exit;
  end;
  Params :=
    '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '"' +
    ' -InstallDir "' + ExpandConstant('{app}') + '"' +
    ' -ListOut "' + PreStopListPath + '"' +
    ' -TimeoutSeconds 90';
  Log('Running pre-stop: ' + Params);
  if not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Log('Pre-stop could not be launched.');
    Exit;
  end;
  Log('Pre-stop exit code: ' + IntToStr(ResultCode));
  // Exit code 1 only means some service refused to stop inside the timeout;
  // the copy is still attempted so the operator sees the real file error.
  Result := True;
end;

// Put back whatever RunPrestopScript stopped. During a successful install the
// services have already been recreated by install-services.ps1, so this is a
// no-op; it exists so a cancelled wizard does not leave the server down.
procedure RestartEverything;
var
  ResultCode: Integer;
  Params: String;
  ScriptPath: String;
begin
  ScriptPath := ExpandConstant('{tmp}\start-vexapacs-services.ps1');
  ExtractTemporaryFile('start-vexapacs-services.ps1');
  if not FileExists(ScriptPath) then
    Exit;
  Params :=
    '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '"' +
    ' -ListPath "' + PreStopListPath + '"' +
    ' -InstallDir "' + ExpandConstant('{app}') + '"';
  Log('Restoring services: ' + Params);
  Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure InitializeWizard;
begin
  // Detect the existing installation BEFORE any page is created so the wizard
  // can be labelled as an update and the data path pre-filled.
  PreviousVersion := GetPreviousVersion;
  PreviousInstallDir := GetPreviousInstallLocation;
  InstalledServices := DetectInstalledServices;
  IsUpgrade := (PreviousVersion <> '') or (InstalledServices <> '');

  LiveDataDir := ReadProgramDataJsonString('backup.config.json', 'dataPath');
  if LiveDataDir = '' then
    LiveDataDir := ReadProgramDataJsonString('backup.config.json', 'backupRoot');
  LiveDataDirKnown := LiveDataDir <> '';
  PreStopListPath := ExpandConstant('{tmp}\\vexapacs-prestop-services.txt');
  PreStopRan := False;

  RamProfilePage := CreateInputOptionPage(
    wpSelectComponents,
    'Server RAM Profile',
    'Select the RAM capacity of the target server.',
    'This adjusts internal cache sizes for optimal performance. Choose 32GB if your server has 32 GB or more RAM.',
    False,
    False
  );
  RamProfilePage.Add('16 GB (Standard)');
  RamProfilePage.Add('32 GB (Recommended)');
  RamProfilePage.Values[0] := False;
  RamProfilePage.Values[1] := True;

  DataDirPage := CreateInputDirPage(
    wpSelectComponents,
    'DICOM Storage Location',
    'Select the DATA folder for DICOM storage.',
    'Browse to a folder on a drive with large capacity. Example: D:\VEXAPACS-DATA' + #13#10 +
    'Click Browse to select the folder.',
    False,
    ''
  );
  DataDirPage.Add('');
  // On an upgrade, pre-fill the path the running server ACTUALLY uses. This page
  // has no default and is required, and it is the only thing binding the DICOM
  // files on disk to the metadata tables: re-entering a different path orphans
  // every historical study (files present, QIDO empty).
  if (LiveDataDirKnown) then
    DataDirPage.Values[0] := LiveDataDir;

  BackupDirPage := CreateInputDirPage(
    DataDirPage.ID,
    'Backup & Restore Location',
    'Set the backup destination folder.',
    'Browse to a folder for automated backups. Example: D:\VEXAPACS-Backup' + #13#10 +
    'Click Browse to select the folder.',
    False,
    ''
  );
  BackupDirPage.Add('');
  BackupDirPage.Values[0] := 'D:\VEXAPACS-Backup';
  AccessEndpointPage := CreateInputQueryPage(
    BackupDirPage.ID,
    'Local and Public Access',
    'Configure local access by IP and public access by domain.',
    'Local host can be left empty to listen on all local IPs. Public domain can be left empty if not in use. For automatic HTTPS, use public port 443 and a valid domain.'
  );
  AccessEndpointPage.Add('Local IP/host:', False);
  AccessEndpointPage.Add('Local port:', False);
  AccessEndpointPage.Add('Public domain:', False);
  AccessEndpointPage.Add('Public port:', False);
  AccessEndpointPage.Values[0] := '';
  AccessEndpointPage.Values[1] := '80';
  AccessEndpointPage.Values[2] := '';
  AccessEndpointPage.Values[3] := '443';

  DatabaseConnectionPage := CreateInputQueryPage(
    AccessEndpointPage.ID,
    'PostgreSQL Connection',
    'Enter PostgreSQL server credential.',
    'PostgreSQL must already be installed and running. These credentials are used by the installer to create and configure the RIS and PACS databases.'
  );
  DatabaseConnectionPage.Add('DB Host:', False);
  DatabaseConnectionPage.Add('DB Port:', False);
  DatabaseConnectionPage.Add('DB User:', False);
  DatabaseConnectionPage.Add('DB Password:', True);
  DatabaseConnectionPage.Values[0] := 'localhost';
  DatabaseConnectionPage.Values[1] := '5432';
  DatabaseConnectionPage.Values[2] := 'postgres';
  DatabaseConnectionPage.Values[3] := 'velo';

  DatabaseNamesPage := CreateInputQueryPage(
    DatabaseConnectionPage.ID,
    'PostgreSQL Database Names',
    'Set database names for RIS and PACS separately.',
    'RIS DB stores RIS/MWL/orders/users/reports. PACS DB stores DICOM/PACS metadata and MWL registry metadata.'
  );
  DatabaseNamesPage.Add('RIS DB Name:', False);
  DatabaseNamesPage.Add('PACS DB Name:', False);
  LiveRisDbName := ResolveLiveRisDbName;
  LivePacsDbName := ResolveLivePacsDbName;
  DatabaseNamesPage.Values[0] := LiveRisDbName;
  DatabaseNamesPage.Values[1] := LivePacsDbName;

  DicomServicesPage := CreateInputQueryPage(
    DatabaseNamesPage.ID,
    'DICOM Services',
    'Configure PACS DIMSE and RIS Modality Worklist.',
    'These values are pre-filled and can be customized for each hospital.'
  );
  DicomServicesPage.Add('PACS AET:', False);
  DicomServicesPage.Add('PACS DIMSE Port:', False);
  DicomServicesPage.Add('RIS MWL AET:', False);
  DicomServicesPage.Add('RIS MWL Port:', False);
  DicomServicesPage.Values[0] := 'VEXA';
  DicomServicesPage.Values[1] := '8889';
  DicomServicesPage.Values[2] := 'VEXARIS';
  DicomServicesPage.Values[3] := '8887';
end;

function GetRamProfile(Param: String): String;
begin
  if RamProfilePage.Values[1] then
    Result := 'high'
  else
    Result := 'standard';
end;

function GetDataDir(Param: String): String;
var
  Value: String;
begin
  Value := Trim(DataDirPage.Values[0]);
  if (Length(Value) = 2) and (Copy(Value, 2, 1) = ':') then
    Value := Value + '\VEXAPACS-DATA'
  else if (Length(Value) = 3) and (Copy(Value, 2, 2) = ':\') then
    Value := Value + 'VEXAPACS-DATA';
  Result := Value;
end;

function GetBackupRoot(Param: String): String;
var
  Value: String;
begin
  Value := Trim(BackupDirPage.Values[0]);
  if (Length(Value) = 2) and (Copy(Value, 2, 1) = ':') then
    Value := Value + '\VEXAPACS-Backup'
  else if (Length(Value) = 3) and (Copy(Value, 2, 2) = ':\') then
    Value := Value + 'VEXAPACS-Backup';
  Result := Value;
end;

function PsQuote(Value: String): String;
begin
  StringChangeEx(Value, '''', '''''', True);
  Result := '''' + Value + '''';
end;

function GetLocalHost(Param: String): String;
begin
  Result := Trim(AccessEndpointPage.Values[0]);
end;

function GetLocalPort(Param: String): String;
begin
  Result := Trim(AccessEndpointPage.Values[1]);
  if Result = '' then
    Result := '80';
end;

function GetPublicHost(Param: String): String;
begin
  Result := Trim(AccessEndpointPage.Values[2]);
end;

function GetPublicPort(Param: String): String;
begin
  Result := Trim(AccessEndpointPage.Values[3]);
  if Result = '' then
    Result := '443';
end;

function GetDbHost(Param: String): String;
begin
  Result := Trim(DatabaseConnectionPage.Values[0]);
  if Result = '' then
    Result := 'localhost';
end;

function GetDbPort(Param: String): String;
begin
  Result := Trim(DatabaseConnectionPage.Values[1]);
  if Result = '' then
    Result := '5432';
end;

function GetDbUser(Param: String): String;
begin
  Result := Trim(DatabaseConnectionPage.Values[2]);
  if Result = '' then
    Result := 'postgres';
end;

function GetDbPass(Param: String): String;
begin
  Result := DatabaseConnectionPage.Values[3];
end;

function GetRisDbName(Param: String): String;
begin
  Result := Trim(DatabaseNamesPage.Values[0]);
  if Result = '' then
    Result := '{#DefaultRisDb}';
end;

function GetPacsDbName(Param: String): String;
begin
  Result := Trim(DatabaseNamesPage.Values[1]);
  if Result = '' then
    Result := '{#DefaultPacsDb}';
end;

function GetPacsAet(Param: String): String;
begin
  Result := Uppercase(Trim(DicomServicesPage.Values[0]));
end;

function GetPacsPort(Param: String): String;
begin
  Result := Trim(DicomServicesPage.Values[1]);
end;

function GetMwlAet(Param: String): String;
begin
  Result := Uppercase(Trim(DicomServicesPage.Values[2]));
end;

function GetMwlPort(Param: String): String;
begin
  Result := Trim(DicomServicesPage.Values[3]);
end;

function AppendModule(Current: String; ModuleName: String): String;
begin
  if Current = '' then
    Result := ModuleName
  else
    Result := Current + ',' + ModuleName;
end;

function GetSelectedModules(Param: String): String;
var
  Modules: String;
begin
  Modules := '';
  if WizardIsComponentSelected('ris') then
    Modules := AppendModule(Modules, 'RIS');
  if WizardIsComponentSelected('pacs_dimse') then
    Modules := AppendModule(Modules, 'PACS_DIMSE');
  if WizardIsComponentSelected('pacs_mwl') then
    Modules := AppendModule(Modules, 'PACS_MWL');
  if WizardIsComponentSelected('desktop_viewer') then
    Modules := AppendModule(Modules, 'DESKTOP_VIEWER');
  if WizardIsComponentSelected('mobile_viewer') then
    Modules := AppendModule(Modules, 'MOBILE_VIEWER');
  if WizardIsComponentSelected('ecg_viewer') then
    Modules := AppendModule(Modules, 'ECG_VIEWER');
  Result := Modules;
end;

function ShouldInstallPacs: Boolean;
begin
  Result := WizardIsComponentSelected('pacs_dimse') or WizardIsComponentSelected('pacs_mwl');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  MessageText: String;
begin
  Result := True;

  // Label the run so nobody mistakes this for a fresh install.
  if IsUpgrade then
  begin
    WizardForm.Caption := 'Update VEXAPACS-RIS ' + '{#MyAppVersion}';
    if PreviousVersion <> '' then
      WizardForm.WelcomeLabel1.Caption := 'Welcome to the VEXAPACS-RIS update ' + '{#MyAppVersion}';
    WizardForm.WelcomeLabel2.Caption :=
      'This installer updates the existing VEXAPACS-RIS installation' + #13#10 +
      'without removing the database, DICOM data, or configuration.';
  end;

  // Confirm the update once, on leaving the first wizard page. Answering No
  // cancels Setup before anything is written, so a declined update leaves the
  // server exactly as it was.
  if (CurPageID = wpWelcome) and IsUpgrade and (not UpgradeDeclined) then
  begin
    MessageText :=
      'VEXAPACS-RIS is already installed on this server.' + #13#10 + #13#10;
    if PreviousVersion <> '' then
      MessageText := MessageText + 'Installed version : ' + PreviousVersion + #13#10;
    MessageText := MessageText + 'Installer version : {#MyAppVersion}' + #13#10;
    if PreviousInstallDir <> '' then
      MessageText := MessageText + 'Install location  : ' + PreviousInstallDir + #13#10;
    if InstalledServices <> '' then
      MessageText := MessageText + 'Services detected : ' + InstalledServices + #13#10;
    if LiveDataDirKnown then
      MessageText := MessageText + 'Active DICOM DATA : ' + LiveDataDir + #13#10;
    MessageText := MessageText + #13#10 +
      'Continue the UPDATE (bug fixes) without removing data?' + #13#10 + #13#10 +
      'The RIS and PACS databases are NOT removed.' + #13#10 +
      'DICOM files in the DATA folder are NOT removed.' + #13#10 +
      'settings.json, backup.config.json, and the license are preserved.' + #13#10 +
      'The installer stops the services and starts them again.' + #13#10 + #13#10 +
      'IMPORTANT: on the "DICOM Storage Location" page, do not change the DATA folder' + #13#10 +
      'unless you are deliberately moving it. A different path hides every' + #13#10 +
      'historical study (the files remain on disk, the worklist becomes empty).' + #13#10 + #13#10 +
      'Choose No to cancel and leave the server as it is.';
    if MsgBox(MessageText, mbConfirmation, MB_YESNO) <> IDYES then
    begin
      UpgradeDeclined := True;
      Result := False;
      Exit;
    end;
  end;

  if CurPageID = DataDirPage.ID then
  begin
    if Trim(DataDirPage.Values[0]) = '' then
    begin
      MsgBox('DATA folder is required.', mbError, MB_OK);
      Result := False;
    end;
    // Guard the one input that can orphan the archive: on an upgrade, changing
    // the storage path away from the live value hides every historical study.
    if Result and IsUpgrade and LiveDataDirKnown and
       (Trim(DataDirPage.Values[0]) <> Trim(LiveDataDir)) then
    begin
      MessageText :=
        'The DATA folder you entered differs from the one the server is using.' + #13#10 + #13#10 +
        'In use       : ' + LiveDataDir + #13#10 +
        'Selected     : ' + Trim(DataDirPage.Values[0]) + #13#10 + #13#10 +
        'Unless this is a deliberate data move, every historical study' + #13#10 +
        'disappears from the worklist (the DICOM files stay on disk, they just' + #13#10 +
        'can no longer be read).' + #13#10 + #13#10 +
        'Continue with the new DATA folder?';
      if MsgBox(MessageText, mbConfirmation, MB_YESNO) <> IDYES then
      begin
        DataDirPage.Values[0] := LiveDataDir;
        Result := False;
        Exit;
      end;
    end;
  end;
  if CurPageID = BackupDirPage.ID then
  begin
    if Trim(BackupDirPage.Values[0]) = '' then
    begin
      MsgBox('Backup & Restore folder is required.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if CurPageID = AccessEndpointPage.ID then
  begin
    if Trim(AccessEndpointPage.Values[1]) = '' then
    begin
      MsgBox('Local port is required.', mbError, MB_OK);
      Result := False;
    end;
    if (Trim(AccessEndpointPage.Values[2]) <> '') and (Trim(AccessEndpointPage.Values[3]) = '') then
    begin
      MsgBox('Public port is required when public domain is filled.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if CurPageID = DatabaseConnectionPage.ID then
  begin
    if Trim(DatabaseConnectionPage.Values[0]) = '' then
    begin
      MsgBox('DB Host is required.', mbError, MB_OK);
      Result := False;
    end;
    if Trim(DatabaseConnectionPage.Values[1]) = '' then
    begin
      MsgBox('DB Port is required.', mbError, MB_OK);
      Result := False;
    end;
    if Trim(DatabaseConnectionPage.Values[2]) = '' then
    begin
      MsgBox('DB User is required.', mbError, MB_OK);
      Result := False;
    end;
    if DatabaseConnectionPage.Values[3] = '' then
    begin
      MsgBox('DB Password is required. Enter the PostgreSQL password configured on this server.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if CurPageID = DatabaseNamesPage.ID then
  begin
    if Trim(DatabaseNamesPage.Values[0]) = '' then
    begin
      MsgBox('RIS DB Name is required.', mbError, MB_OK);
      Result := False;
    end;
    if Trim(DatabaseNamesPage.Values[1]) = '' then
    begin
      MsgBox('PACS DB Name is required.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if CurPageID = DicomServicesPage.ID then
  begin
    if (GetPacsAet('') = '') or (Length(GetPacsAet('')) > 16) then
    begin
      MsgBox('PACS AET is required and may contain at most 16 characters.', mbError, MB_OK);
      Result := False;
    end;
    if (StrToIntDef(GetPacsPort(''), 0) < 1) or (StrToIntDef(GetPacsPort(''), 0) > 65534) then
    begin
      MsgBox('PACS DIMSE port must be between 1 and 65534.', mbError, MB_OK);
      Result := False;
    end;
    if (GetMwlAet('') = '') or (Length(GetMwlAet('')) > 16) then
    begin
      MsgBox('RIS MWL AET is required and may contain at most 16 characters.', mbError, MB_OK);
      Result := False;
    end;
    if (StrToIntDef(GetMwlPort(''), 0) < 1) or (StrToIntDef(GetMwlPort(''), 0) > 65535) then
    begin
      MsgBox('RIS MWL port must be between 1 and 65535.', mbError, MB_OK);
      Result := False;
    end;
    if GetPacsPort('') = GetMwlPort('') then
    begin
      MsgBox('PACS DIMSE and RIS MWL ports must be different.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: String;
  LogPath: String;
  WrapperPath: String;
  WrapperLogPath: String;
  Wrapper: String;
begin
  // Runs BEFORE Setup copies files: Setup would otherwise fail to replace
  // binaries that are still open (VexaServiceMonitor.exe, orphaned node.exe,
  // or a running service).
  if CurStep = ssInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Stopping VEXAPACS services...';
    WizardForm.ProgressGauge.Style := npbstMarquee;
    PreStopRan := RunPrestopScript;
    WizardForm.ProgressGauge.Style := npbstNormal;
  end;

  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Configuring VEXAPACS services and license request...';
    WizardForm.ProgressGauge.Style := npbstMarquee;
    LogPath := ExpandConstant('{commonappdata}\VEXAPACS\logs\postinstall.log');
    WrapperPath := ExpandConstant('{tmp}\vexa-postinstall-run.ps1');
    WrapperLogPath := ExpandConstant('{commonappdata}\VEXAPACS\logs\postinstall-launch.ps1');

    Wrapper :=
      '$ErrorActionPreference = ''Stop''' + #13#10 +
      '& ' + PsQuote(ExpandConstant('{app}\installer\scripts\postinstall.ps1')) + ' `' + #13#10 +
      '  -InstallDir ' + PsQuote(ExpandConstant('{app}')) + ' `' + #13#10 +
      '  -Modules ' + PsQuote(GetSelectedModules('')) + ' `' + #13#10 +
      '  -DataDir ' + PsQuote(GetDataDir('')) + ' `' + #13#10 +
      '  -BackupRoot ' + PsQuote(GetBackupRoot('')) + ' `' + #13#10 +
      '  -ProgramDataDir ' + PsQuote(ExpandConstant('{commonappdata}\VEXAPACS')) + ' `' + #13#10 +
      '  -InstallerVersion ' + PsQuote('{#MyAppVersion}') + ' `' + #13#10 +
      '  -LocalHost ' + PsQuote(GetLocalHost('')) + ' `' + #13#10 +
      '  -LocalPort ' + PsQuote(GetLocalPort('')) + ' `' + #13#10 +
      '  -PublicHost ' + PsQuote(GetPublicHost('')) + ' `' + #13#10 +
      '  -PublicPort ' + PsQuote(GetPublicPort('')) + ' `' + #13#10 +
      '  -DbHost ' + PsQuote(GetDbHost('')) + ' `' + #13#10 +
      '  -DbPort ' + PsQuote(GetDbPort('')) + ' `' + #13#10 +
      '  -DbUser ' + PsQuote(GetDbUser('')) + ' `' + #13#10 +
      '  -DbPass ' + PsQuote(GetDbPass('')) + ' `' + #13#10 +
      '  -RisDbName ' + PsQuote(GetRisDbName('')) + ' `' + #13#10 +
      '  -PacsDbName ' + PsQuote(GetPacsDbName('')) + ' `' + #13#10 +
      '  -PacsAet ' + PsQuote(GetPacsAet('')) + ' `' + #13#10 +
      '  -PacsPort ' + PsQuote(GetPacsPort('')) + ' `' + #13#10 +
      '  -MwlAet ' + PsQuote(GetMwlAet('')) + ' `' + #13#10 +
      '  -MwlPort ' + PsQuote(GetMwlPort('')) + ' `' + #13#10 +
      '  -RamProfile ' + PsQuote(GetRamProfile('')) + ' `' + #13#10 +
      '  -StartServices' + #13#10;

    if not SaveStringToFile(WrapperPath, Wrapper, False) then
    begin
      MsgBox('Failed to create post-install launcher: ' + WrapperPath, mbError, MB_OK);
      Abort;
    end;
    SaveStringToFile(WrapperLogPath, Wrapper, False);

    Params :=
      '-NoProfile -ExecutionPolicy Bypass -File "' + WrapperPath + '"';

    if not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      MsgBox('Post-install failed to start. Check: ' + LogPath + #13#10 +
        'Launcher: ' + WrapperLogPath, mbError, MB_OK);
      Abort;
    end;

    if ResultCode <> 0 then
    begin
      MsgBox('Post-install failed with exit code ' + IntToStr(ResultCode) + '.'#13#10 +
        'Check log: ' + LogPath + #13#10 +
        'Launcher: ' + WrapperLogPath, mbError, MB_OK);
      Abort;
    end;

    WizardForm.ProgressGauge.Style := npbstNormal;
  end;
end;

// If the operator cancels at any later page, the pre-stop has already taken the
// server down. Put it back so a cancelled update does not leave production off.
procedure DeinitializeSetup;
begin
  if PreStopRan then
    RestartEverything;
end;
