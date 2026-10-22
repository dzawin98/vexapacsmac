using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Net;
using System.Linq;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Vexa.ServiceMonitor
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var login = new PasswordForm())
            {
                if (login.ShowDialog() != DialogResult.OK) return;
            }
            Application.Run(new MonitorForm());
        }
    }

    internal sealed class PasswordForm : Form
    {
        private readonly TextBox passwordText = new TextBox();
        private readonly Label errorLabel = new Label();

        public PasswordForm()
        {
            Text = "VEXA SYSTEM Access";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(420, 230);
            BackColor = Color.FromArgb(10, 18, 32);
            Font = new Font("Segoe UI", 9F);

            var title = new Label
            {
                Text = "VEXA SYSTEM",
                Dock = DockStyle.Top,
                Height = 48,
                Font = new Font("Segoe UI Semibold", 20F),
                ForeColor = Color.White,
                TextAlign = ContentAlignment.BottomCenter,
            };
            var subtitle = new Label
            {
                Text = "Authorized utility access",
                Dock = DockStyle.Top,
                Height = 28,
                ForeColor = Color.FromArgb(148, 163, 184),
                TextAlign = ContentAlignment.MiddleCenter,
            };
            var prompt = new Label
            {
                Text = "Password",
                Left = 42,
                Top = 94,
                Width = 330,
                Height = 22,
                ForeColor = Color.FromArgb(226, 232, 240),
            };
            passwordText.Left = 42;
            passwordText.Top = 118;
            passwordText.Width = 330;
            passwordText.Height = 28;
            passwordText.UseSystemPasswordChar = true;
            passwordText.KeyDown += delegate(object sender, KeyEventArgs args)
            {
                if (args.KeyCode == Keys.Enter) ValidatePassword();
            };
            var unlock = new Button
            {
                Text = "Unlock",
                Left = 42,
                Top = 158,
                Width = 160,
                Height = 34,
                BackColor = Color.FromArgb(14, 116, 144),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            unlock.FlatAppearance.BorderColor = Color.FromArgb(34, 211, 238);
            unlock.Click += delegate { ValidatePassword(); };
            var close = new Button
            {
                Text = "Close",
                Left = 212,
                Top = 158,
                Width = 160,
                Height = 34,
                BackColor = Color.FromArgb(30, 41, 59),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            close.FlatAppearance.BorderColor = Color.FromArgb(71, 85, 105);
            close.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            errorLabel.Left = 42;
            errorLabel.Top = 198;
            errorLabel.Width = 330;
            errorLabel.Height = 22;
            errorLabel.ForeColor = Color.FromArgb(248, 113, 113);
            errorLabel.TextAlign = ContentAlignment.MiddleCenter;

            Controls.Add(errorLabel);
            Controls.Add(close);
            Controls.Add(unlock);
            Controls.Add(passwordText);
            Controls.Add(prompt);
            Controls.Add(subtitle);
            Controls.Add(title);
        }

        private void ValidatePassword()
        {
            if (passwordText.Text == "Vexa12@#")
            {
                DialogResult = DialogResult.OK;
                Close();
                return;
            }
            errorLabel.Text = "Invalid password.";
            passwordText.SelectAll();
            passwordText.Focus();
        }
    }

    internal sealed class HospitalNameForm : Form
    {
        private readonly TextBox nameText = new TextBox();
        public string HospitalName { get; private set; }

        public HospitalNameForm()
        {
            Text = "Report Identity";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(460, 190);
            BackColor = Color.FromArgb(10, 18, 32);
            Font = new Font("Segoe UI", 9F);

            var title = new Label
            {
                Text = "Hospital Name",
                Left = 34,
                Top = 24,
                Width = 390,
                Height = 34,
                Font = new Font("Segoe UI Semibold", 16F),
                ForeColor = Color.White,
            };
            var hint = new Label
            {
                Text = "Nama ini akan tampil di VEXA SYSTEM PDF report.",
                Left = 34,
                Top = 58,
                Width = 390,
                Height = 24,
                ForeColor = Color.FromArgb(148, 163, 184),
            };
            nameText.Left = 34;
            nameText.Top = 90;
            nameText.Width = 390;
            nameText.Height = 28;
            nameText.Text = "RS NEXIA DEMO";
            nameText.KeyDown += delegate(object sender, KeyEventArgs args)
            {
                if (args.KeyCode == Keys.Enter) Accept();
            };
            var ok = new Button
            {
                Text = "Create Report",
                Left = 34,
                Top = 132,
                Width = 190,
                Height = 34,
                BackColor = Color.FromArgb(14, 116, 144),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            ok.FlatAppearance.BorderColor = Color.FromArgb(34, 211, 238);
            ok.Click += delegate { Accept(); };
            var cancel = new Button
            {
                Text = "Cancel",
                Left = 234,
                Top = 132,
                Width = 190,
                Height = 34,
                BackColor = Color.FromArgb(30, 41, 59),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            cancel.FlatAppearance.BorderColor = Color.FromArgb(71, 85, 105);
            cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };

            Controls.Add(cancel);
            Controls.Add(ok);
            Controls.Add(nameText);
            Controls.Add(hint);
            Controls.Add(title);
        }

        private void Accept()
        {
            HospitalName = string.IsNullOrWhiteSpace(nameText.Text) ? "Hospital" : nameText.Text.Trim();
            DialogResult = DialogResult.OK;
            Close();
        }
    }

    internal sealed class ServiceDefinition
    {
        public ServiceDefinition(string name, string label, string group)
        {
            Name = name;
            Label = label;
            Group = group;
        }

        public string Name { get; private set; }
        public string Label { get; private set; }
        public string Group { get; private set; }
    }

    internal sealed class MetricRow
    {
        public MetricRow(string metric, string value, string notes)
        {
            Metric = metric ?? string.Empty;
            Value = value ?? string.Empty;
            Notes = notes ?? string.Empty;
        }

        public string Metric { get; private set; }
        public string Value { get; private set; }
        public string Notes { get; private set; }
    }

    internal sealed class MonitorForm : Form
    {
        private static readonly ServiceDefinition[] KnownServices =
        {
            new ServiceDefinition("VexaCaddy", "Reverse Proxy", "Gateway"),
            new ServiceDefinition("VexaRISFrontend", "RIS Frontend", "RIS"),
            new ServiceDefinition("VexaRISBackend", "RIS Backend", "RIS"),
            new ServiceDefinition("VexaPacsDicomweb", "PACS DICOMweb", "PACS"),
            new ServiceDefinition("VexaPacsDimse", "PACS DIMSE SCP", "PACS"),
            new ServiceDefinition("VexaMwlService", "RIS MWL SCP", "RIS"),
            new ServiceDefinition("VexaDesktopViewer", "Primary Diagnostic Viewer", "Viewer"),
            new ServiceDefinition("VexaMobileViewer", "Mobile Viewer", "Viewer"),
            new ServiceDefinition("VexaEcgViewer", "ECG Viewer", "Viewer"),
            new ServiceDefinition("VexaBackupAgent", "Backup Agent", "Tools"),
            new ServiceDefinition("VexaSimrsDbBridge", "SIMRS DB Bridge", "Tools"),
        };

        private readonly DataGridView grid = new DataGridView();
        private readonly Label statusLabel = new Label();
        private readonly Label adminLabel = new Label();
        private readonly CheckBox autoRefresh = new CheckBox();
        private readonly Timer refreshTimer = new Timer();
        private readonly DataGridView systemGrid = new DataGridView();
        private readonly Label systemSummaryLabel = new Label();
        private readonly Label systemRecommendationLabel = new Label();
        private readonly Label storageCardValue = new Label();
        private readonly Label storageCardHint = new Label();
        private readonly ProgressBar storageProgress = new ProgressBar();
        private readonly Label backupCardValue = new Label();
        private readonly Label backupCardHint = new Label();
        private readonly Label databaseCardValue = new Label();
        private readonly Label databaseCardHint = new Label();
        private readonly Label studyCardValue = new Label();
        private readonly Label studyCardHint = new Label();
        private readonly RichTextBox mwlLiveLogBox = new RichTextBox();
        private readonly RichTextBox dicomLiveLogBox = new RichTextBox();
        private readonly List<MetricRow> lastSystemMetrics = new List<MetricRow>();
        private StorageEstimate lastStorageEstimate;
        private DateTime lastSystemRefreshAt;
        private string currentDataPath;
        private string currentBackupRoot;
        private TextBox pacsAetText;
        private NumericUpDown pacsPortInput;
        private TextBox mwlAetText;
        private NumericUpDown mwlPortInput;
        private CheckBox storageCompressionCheck;
        private ComboBox storageCompressionProfileSelect;
        private Label dicomConfigStatus;
        private ComboBox configFileSelect;
        private Panel configFieldsPanel;
        private Label configEditorStatus;
        private string activeConfigPath;
        private RichTextBox diagnosticsOutput;
        private Dictionary<string, object> activeConfigDocument;
        private readonly Dictionary<string, Control> configFieldControls = new Dictionary<string, Control>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, ComboBox> viewerButtonControls = new Dictionary<string, ComboBox>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, TextBox> viewerButtonLabelControls = new Dictionary<string, TextBox>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, TextBox> viewerButtonUsernameControls = new Dictionary<string, TextBox>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, TextBox> viewerButtonPasswordControls = new Dictionary<string, TextBox>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Button> viewerButtonTestControls = new Dictionary<string, Button>(StringComparer.OrdinalIgnoreCase);
        private Label orderOutUrlPreviewLabel;
        private const string Jpeg2000LosslessUid = "1.2.840.10008.1.2.4.90";
        private const string JpegLsLosslessUid = "1.2.840.10008.1.2.4.80";
        private readonly string logDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "VEXAPACS",
            "logs"
        );

        public MonitorForm()
        {
            Text = "Vexa System Utility";
            MinimumSize = new Size(980, 620);
            Size = new Size(1120, 720);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9F);
            TryApplyLogo();

            BuildLayout();
            refreshTimer.Interval = 5000;
            refreshTimer.Tick += delegate { RefreshServices(); };
            autoRefresh.Checked = true;
            refreshTimer.Start();

            Shown += delegate
            {
                RefreshServices();
                LoadDicomConfig();
                LoadSelectedConfigFile();
            };
        }

        private void BuildLayout()
        {
            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 3,
                ColumnCount = 1,
                Padding = new Padding(12),
            };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));

            var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3 };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 58));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 250));
            var logo = new PictureBox
            {
                Dock = DockStyle.Fill,
                SizeMode = PictureBoxSizeMode.Zoom,
                Margin = new Padding(0, 4, 10, 4),
            };
            var logoPath = FindLogoPath();
            if (!string.IsNullOrWhiteSpace(logoPath))
            {
                try { logo.Image = Image.FromFile(logoPath); }
                catch { logo.Image = null; }
            }
            var title = new Label
            {
                Text = "Vexa System Utility",
                Dock = DockStyle.Fill,
                Font = new Font("Segoe UI Semibold", 18F),
                TextAlign = ContentAlignment.MiddleLeft,
            };
            adminLabel.Dock = DockStyle.Fill;
            adminLabel.TextAlign = ContentAlignment.MiddleRight;
            header.Controls.Add(logo, 0, 0);
            header.Controls.Add(title, 1, 0);
            header.Controls.Add(adminLabel, 2, 0);

            var tabs = new TabControl { Dock = DockStyle.Fill };
            var servicesTab = new TabPage("Services");
            var systemTab = new TabPage("System Monitor");
            var liveLogsTab = new TabPage("Live DICOM Logs");
            var dicomTab = new TabPage("DICOM Config");
            var configurationTab = new TabPage("System Settings");
            var diagnosticsTab = new TabPage("Diagnostics & Recovery");

            var servicesRoot = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 2,
                ColumnCount = 1,
                Padding = new Padding(0, 8, 0, 0),
            };
            servicesRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
            servicesRoot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            var toolbar = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
            };
            toolbar.Controls.Add(Button("Refresh", delegate { RefreshServices(); }));
            toolbar.Controls.Add(Button("Start", async delegate { await ServiceAction("start"); }));
            toolbar.Controls.Add(Button("Stop", async delegate { await ServiceAction("stop"); }));
            toolbar.Controls.Add(Button("Restart", async delegate { await ServiceAction("restart"); }));
            toolbar.Controls.Add(Button("Restart All", async delegate { await RestartAll(); }));
            toolbar.Controls.Add(Button("Open Logs", delegate { OpenPath(logDir); }));
            toolbar.Controls.Add(Button("Open .err", delegate { OpenSelectedLog(".err.log"); }));
            toolbar.Controls.Add(Button("Open .out", delegate { OpenSelectedLog(".out.log"); }));
            toolbar.Controls.Add(Button("Run as Admin", delegate { RelaunchElevated(); }));
            autoRefresh.Text = "Auto refresh";
            autoRefresh.AutoSize = true;
            autoRefresh.Padding = new Padding(14, 8, 0, 0);
            autoRefresh.CheckedChanged += delegate
            {
                refreshTimer.Enabled = autoRefresh.Checked;
            };
            toolbar.Controls.Add(autoRefresh);

            grid.Dock = DockStyle.Fill;
            grid.AllowUserToAddRows = false;
            grid.AllowUserToDeleteRows = false;
            grid.AllowUserToResizeRows = false;
            grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            grid.BackgroundColor = Color.White;
            grid.BorderStyle = BorderStyle.FixedSingle;
            grid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
            grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize;
            grid.MultiSelect = false;
            grid.ReadOnly = true;
            grid.RowHeadersVisible = false;
            grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            grid.Columns.Add("Group", "Group");
            grid.Columns.Add("Name", "Service Name");
            grid.Columns.Add("Label", "Label");
            grid.Columns.Add("Status", "Status");
            grid.Columns.Add("StartType", "Start Type");
            grid.Columns.Add("CanStop", "Can Stop");
            grid.Columns.Add("DisplayName", "Windows Display Name");
            grid.Columns["Group"].FillWeight = 70;
            grid.Columns["Name"].FillWeight = 120;
            grid.Columns["Label"].FillWeight = 140;
            grid.Columns["Status"].FillWeight = 90;
            grid.Columns["StartType"].FillWeight = 90;
            grid.Columns["CanStop"].FillWeight = 70;
            grid.Columns["DisplayName"].FillWeight = 220;
            grid.CellDoubleClick += delegate { OpenSelectedLog(".err.log"); };

            servicesRoot.Controls.Add(toolbar, 0, 0);
            servicesRoot.Controls.Add(grid, 0, 1);
            servicesTab.Controls.Add(servicesRoot);
            systemTab.Controls.Add(BuildSystemMonitorPanel());
            liveLogsTab.Controls.Add(BuildLiveLogsPanel());
            dicomTab.Controls.Add(BuildDicomConfigPanel());
            configurationTab.Controls.Add(BuildConfigurationEditorPanel());
            diagnosticsTab.Controls.Add(BuildDiagnosticsRecoveryPanel());
            tabs.TabPages.Add(servicesTab);
            tabs.TabPages.Add(systemTab);
            tabs.TabPages.Add(liveLogsTab);
            tabs.TabPages.Add(dicomTab);
            tabs.TabPages.Add(configurationTab);
            tabs.TabPages.Add(diagnosticsTab);

            statusLabel.Dock = DockStyle.Fill;
            statusLabel.TextAlign = ContentAlignment.MiddleLeft;
            statusLabel.ForeColor = Color.DimGray;

            root.Controls.Add(header, 0, 0);
            root.Controls.Add(tabs, 0, 1);
            root.Controls.Add(statusLabel, 0, 2);
            Controls.Add(root);
        }

        private sealed class ConfigFileOption
        {
            public ConfigFileOption(string label, string relativePath, params string[] services)
            {
                Label = label;
                RelativePath = relativePath;
                Services = services ?? new string[0];
            }

            public string Label { get; private set; }
            public string RelativePath { get; private set; }
            public string[] Services { get; private set; }
            public string ViewerId { get; set; }
            public override string ToString() { return Label; }
        }

        private sealed class IntegrationModeOption
        {
            public IntegrationModeOption(string label, string mode, string driver) { Label = label; Mode = mode; Driver = driver; }
            public string Label { get; private set; }
            public string Mode { get; private set; }
            public string Driver { get; private set; }
            public override string ToString() { return Label; }
        }

        private sealed class ConfigChoiceOption
        {
            public ConfigChoiceOption(string label, string value) { Label = label; Value = value; }
            public string Label { get; private set; }
            public string Value { get; private set; }
            public override string ToString() { return Label; }
        }

        private sealed class ViewerButtonOption
        {
            public ViewerButtonOption(string label, string type, string viewerId) { Label = label; Type = type; ViewerId = viewerId; }
            public string Label { get; private set; }
            public string Type { get; private set; }
            public string ViewerId { get; private set; }
            public override string ToString() { return Label; }
        }

        private Control BuildConfigurationEditorPanel()
        {
            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 4,
                ColumnCount = 1,
                Padding = new Padding(12),
            };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));

            var toolbar = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
            };
            configFileSelect = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                Width = 300,
                Margin = new Padding(0, 6, 10, 0),
            };
            configFileSelect.Items.Add(new ConfigFileOption("RIS & Facility", Path.Combine("RIS", "backend", "settings.json"), "VexaRISBackend", "VexaSimrsDbBridge"));
            configFileSelect.Items.Add(new ConfigFileOption("PACS & Storage", Path.Combine("PACS", "config", "default.json"), "VexaPacsDicomweb", "VexaPacsDimse"));
            configFileSelect.Items.Add(new ConfigFileOption("RIS Connections", Path.Combine("RIS", "frontend", "public", "settings.json"), "VexaRISFrontend"));
            configFileSelect.Items.Add(new ConfigFileOption("Primary Diagnostic Viewer", Path.Combine("RIS", "backend", "settings.json"), "VexaRISBackend", "VexaDesktopViewer") { ViewerId = "vexa-pacs" });
            configFileSelect.Items.Add(new ConfigFileOption("Mobile Viewer", Path.Combine("RIS", "backend", "settings.json"), "VexaRISBackend", "VexaMobileViewer") { ViewerId = "vexa-mobile" });
            configFileSelect.Items.Add(new ConfigFileOption("ECG Viewer", Path.Combine("RIS", "backend", "settings.json"), "VexaRISBackend") { ViewerId = "ecg-viewer" });
            configFileSelect.SelectedIndexChanged += delegate { LoadSelectedConfigFile(); };
            configFileSelect.SelectedIndex = 0;
            toolbar.Controls.Add(configFileSelect);
            toolbar.Controls.Add(Button("Refresh", delegate { LoadSelectedConfigFile(); }));
            toolbar.Controls.Add(Button("Check Settings", delegate { ValidateConfigEditor(true); }));
            toolbar.Controls.Add(Button("Apply", async delegate { await SaveSelectedConfigFile(false); }));
            toolbar.Controls.Add(Button("Apply + Restart", async delegate { await SaveSelectedConfigFile(true); }));

            var hint = new Label
            {
                Dock = DockStyle.Fill,
                Text = "Select a system module, adjust its settings, then apply the changes.",
                ForeColor = Color.DimGray,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            configFieldsPanel = new Panel
            {
                Dock = DockStyle.Fill,
                AutoScroll = true,
                BackColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };
            configEditorStatus = new Label
            {
                Dock = DockStyle.Fill,
                ForeColor = Color.DimGray,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            root.Controls.Add(toolbar, 0, 0);
            root.Controls.Add(hint, 0, 1);
            root.Controls.Add(configFieldsPanel, 0, 2);
            root.Controls.Add(configEditorStatus, 0, 3);
            return root;
        }

        private ConfigFileOption SelectedConfigFile()
        {
            return configFileSelect == null ? null : configFileSelect.SelectedItem as ConfigFileOption;
        }

        private void LoadSelectedConfigFile()
        {
            if (configFileSelect == null || configFieldsPanel == null) return;
            var selected = SelectedConfigFile();
            var installDir = FindInstallDir();
            if (selected == null || string.IsNullOrWhiteSpace(installDir)) return;
            activeConfigPath = Path.Combine(installDir, selected.RelativePath);
            try
            {
                if (!File.Exists(activeConfigPath))
                {
                    configFieldsPanel.Controls.Clear();
                    configEditorStatus.Text = "Configuration file not found: " + activeConfigPath;
                    configEditorStatus.ForeColor = Color.Firebrick;
                    return;
                }
                var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                activeConfigDocument = serializer.DeserializeObject(File.ReadAllText(activeConfigPath, Encoding.UTF8)) as Dictionary<string, object>;
                if (activeConfigDocument == null) throw new InvalidOperationException("The configuration root must be a JSON object.");
                BuildStructuredConfigFields();
                configEditorStatus.Text = selected.Label + " settings are ready.";
                configEditorStatus.ForeColor = Color.DimGray;
            }
            catch (Exception ex)
            {
                configEditorStatus.Text = "Load failed: " + ex.Message;
                configEditorStatus.ForeColor = Color.Firebrick;
            }
        }

        private bool ValidateConfigEditor(bool showSuccess)
        {
            try
            {
                ApplyStructuredConfigFields();
                configEditorStatus.Text = "All settings are valid.";
                configEditorStatus.ForeColor = Color.SeaGreen;
                if (showSuccess) MessageBox.Show(this, "All settings are valid.", "Configuration", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return true;
            }
            catch (Exception ex)
            {
                configEditorStatus.Text = "Invalid setting: " + ex.Message;
                configEditorStatus.ForeColor = Color.Firebrick;
                MessageBox.Show(this, "Configuration was not saved.\r\n\r\n" + ex.Message, "Invalid Setting", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
        }

        private async Task SaveSelectedConfigFile(bool restartServices)
        {
            var selected = SelectedConfigFile();
            if (selected == null || string.IsNullOrWhiteSpace(activeConfigPath)) return;
            if (!ValidateConfigEditor(false)) return;
            if (MessageBox.Show(this, "Apply changes to " + selected.Label + (restartServices ? " and restart the related services?" : "?"), "Apply Settings", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            var directory = Path.GetDirectoryName(activeConfigPath);
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var backupPath = activeConfigPath + ".bak-" + stamp;
            var tempPath = activeConfigPath + ".tmp";
            try
            {
                var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                File.WriteAllText(tempPath, serializer.Serialize(activeConfigDocument), new UTF8Encoding(false));
                File.Replace(tempPath, activeConfigPath, backupPath, true);
                WriteSettingsAudit("APPLY", selected.Label + (restartServices ? " | restart requested" : ""));
                configEditorStatus.Text = selected.Label + " settings applied successfully.";
                configEditorStatus.ForeColor = Color.SeaGreen;
                if (restartServices)
                {
                    foreach (var serviceName in selected.Services.Distinct(StringComparer.OrdinalIgnoreCase))
                    {
                        await RunServiceAction(serviceName, "restart", false);
                    }
                    configEditorStatus.Text += " | Related services restarted.";
                }
                MessageBox.Show(this, restartServices ? "Settings applied and related services restarted." : "Settings applied successfully.", "System Settings", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
                configEditorStatus.Text = "Save failed: " + ex.Message;
                configEditorStatus.ForeColor = Color.Firebrick;
                MessageBox.Show(this, "Unable to save configuration. Run the utility as Administrator.\r\n\r\n" + ex.Message, "Save Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private Control BuildDiagnosticsRecoveryPanel()
        {
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1, Padding = new Padding(12) };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
            toolbar.Controls.Add(Button("Run Preflight Check", async delegate { await RunPreflightCheck(); }));
            toolbar.Controls.Add(Button("Sync All Data", async delegate { await RunFullDataSync(); }));
            toolbar.Controls.Add(Button("Backup Settings", delegate { BackupAllSettings("manual"); }));
            toolbar.Controls.Add(Button("Restore Latest Backup", delegate { RestoreLatestSettingsBackup(); }));
            toolbar.Controls.Add(Button("Open Backup Folder", delegate { OpenPath(SettingsBackupRoot()); }));
            toolbar.Controls.Add(Button("Open Audit Log", delegate { OpenPath(SettingsAuditPath()); }));
            var hint = new Label { Dock = DockStyle.Fill, Text = "Validate services before deployment, create recovery points, and review configuration activity.", ForeColor = Color.DimGray, TextAlign = ContentAlignment.MiddleLeft };
            diagnosticsOutput = new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, WordWrap = false, Font = new Font("Consolas", 10F), BackColor = Color.White, ForeColor = Color.FromArgb(30, 41, 59), BorderStyle = BorderStyle.FixedSingle };
            root.Controls.Add(toolbar, 0, 0);
            root.Controls.Add(hint, 0, 1);
            root.Controls.Add(diagnosticsOutput, 0, 2);
            return root;
        }

        private async Task RunPreflightCheck()
        {
            diagnosticsOutput.Text = "Running preflight checks...";
            var report = await Task.Run(delegate
            {
                var lines = new List<string> { "VEXA PREFLIGHT CHECK", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), "" };
                var listeners = new HashSet<int>(IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Select(item => item.Port));
                AddPortCheck(lines, listeners, 3001, "RIS Backend API", true);
                AddPortCheck(lines, listeners, 5001, "PACS DICOMweb", true);
                AddPortCheck(lines, listeners, 8890, "PACS DIMSE", true);
                AddPortCheck(lines, listeners, 5994, "Primary Diagnostic Viewer", true);
                AddPortCheck(lines, listeners, 5992, "Mobile Viewer", false);
                AddPortCheck(lines, listeners, 7771, "ECG Viewer", false);
                AddPortCheck(lines, listeners, 3109, "SIMRS Database Bridge", false);
                lines.Add(PreflightHttp("http://127.0.0.1:3001/api/health", "RIS API health"));
                lines.Add(PreflightHttp("http://127.0.0.1:5001/health", "DICOMweb health"));
                var installDir = FindInstallDir();
                foreach (var option in ManagedConfigFiles())
                {
                    var path = Path.Combine(installDir, option.RelativePath);
                    lines.Add(ValidateJsonFile(path) ? "[PASS] Settings: " + option.Label : "[FAIL] Settings: " + option.Label);
                }
                try
                {
                    var pacsPath = Path.Combine(installDir, "PACS", "config", "default.json");
                    var pacs = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(pacsPath)) as Dictionary<string, object>;
                    var storagePath = pacs != null && pacs.ContainsKey("storagePath") ? Convert.ToString(pacs["storagePath"]) : string.Empty;
                    if (!string.IsNullOrWhiteSpace(storagePath) && Directory.Exists(storagePath))
                    {
                        var drive = new DriveInfo(Path.GetPathRoot(storagePath));
                        lines.Add("[PASS] Storage: " + storagePath + " | Free " + FormatBytes(drive.AvailableFreeSpace));
                        if (drive.AvailableFreeSpace < 10L * 1024 * 1024 * 1024) lines.Add("[WARN] Storage free space is below 10 GB.");
                    }
                    else lines.Add("[FAIL] Storage path is unavailable.");
                }
                catch (Exception ex) { lines.Add("[FAIL] Storage check: " + ex.Message); }
                return string.Join(Environment.NewLine, lines);
            });
            diagnosticsOutput.Text = report;
            WriteSettingsAudit("PREFLIGHT", report.Contains("[FAIL]") ? "completed with failures" : "passed");
        }

        // "Sync All Data": rebuild PACS metadata from the DICOM storage folder,
        // then reconcile RIS MWL orders against what PACS actually holds. Both
        // steps run server-side (RIS backend /api/system/sync/all) because only
        // the server may read the storage tree; the endpoints reject non-loopback
        // callers, so this must be run on the server itself.
        private async Task RunFullDataSync()
        {
            diagnosticsOutput.Text = "Menjalankan sinkronisasi data (PACS metadata + RIS order)..."
                + Environment.NewLine + Environment.NewLine
                + "Proses ini membaca ulang seluruh folder DICOM dan bisa memakan waktu"
                + Environment.NewLine
                + "beberapa menit pada storage besar. Jangan tutup jendela ini.";

            var report = await Task.Run(delegate
            {
                var lines = new List<string>
                {
                    "VEXA FULL DATA SYNC",
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                    ""
                };

                var installDir = FindInstallDir();
                var risPort = ResolveRisPort(installDir);
                var url = "http://127.0.0.1:" + risPort + "/api/system/sync/all";

                try
                {
                    var request = (HttpWebRequest)WebRequest.Create(url);
                    request.Method = "POST";
                    request.ContentType = "application/json";
                    request.Timeout = 30 * 60 * 1000;      // a full storage rescan can be slow
                    request.ReadWriteTimeout = 30 * 60 * 1000;
                    var payload = Encoding.UTF8.GetBytes("{}");
                    request.ContentLength = payload.Length;
                    using (var stream = request.GetRequestStream()) stream.Write(payload, 0, payload.Length);

                    using (var response = (HttpWebResponse)request.GetResponse())
                    using (var reader = new StreamReader(response.GetResponseStream()))
                    {
                        var json = reader.ReadToEnd();
                        var parsed = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }
                            .DeserializeObject(json) as Dictionary<string, object>;
                        lines.Add(DescribeSyncResponse(parsed, (int)response.StatusCode));
                    }
                }
                catch (WebException ex)
                {
                    var httpResponse = ex.Response as HttpWebResponse;
                    if (httpResponse != null)
                    {
                        using (httpResponse)
                        using (var reader = new StreamReader(httpResponse.GetResponseStream()))
                        {
                            var body = reader.ReadToEnd();
                            if ((int)httpResponse.StatusCode == 403)
                            {
                                lines.Add("[FAIL] Sinkronisasi ditolak server.");
                                lines.Add("        Endpoint ini hanya menerima request dari localhost.");
                                lines.Add("        Jalankan Vexa System Utility langsung di server, bukan dari PC lain.");
                            }
                            else
                            {
                                lines.Add("[FAIL] HTTP " + (int)httpResponse.StatusCode);
                                if (!string.IsNullOrWhiteSpace(body)) lines.Add("        " + body.Trim());
                            }
                        }
                    }
                    else
                    {
                        lines.Add("[FAIL] RIS backend tidak dapat dihubungi di " + url);
                        lines.Add("        " + ex.Message);
                        lines.Add("        Pastikan service VexaRISBackend berjalan, lalu coba lagi.");
                    }
                }
                catch (Exception ex)
                {
                    lines.Add("[FAIL] " + ex.Message);
                }

                return string.Join(Environment.NewLine, lines);
            });

            diagnosticsOutput.Text = report;
            WriteSettingsAudit("DATA_SYNC", report.Contains("[FAIL]") ? "completed with failures" : "completed");
        }

        // Renders the /api/system/sync/all response into readable lines.
        private string DescribeSyncResponse(Dictionary<string, object> parsed, int httpStatus)
        {
            var lines = new List<string> { "[PASS] RIS backend merespons HTTP " + httpStatus, "" };
            if (parsed == null)
            {
                lines.Add("(respons kosong)");
                return string.Join(Environment.NewLine, lines);
            }

            object elapsed;
            if (parsed.TryGetValue("elapsedMs", out elapsed))
            {
                lines.Add("Total waktu: " + FormatDuration(elapsed) + " (" + elapsed + " ms)");
                lines.Add("");
            }

            object stepsValue;
            var steps = parsed.TryGetValue("steps", out stepsValue) ? stepsValue as Dictionary<string, object> : null;
            if (steps == null)
            {
                lines.Add("(tidak ada detail langkah pada respons)");
                return string.Join(Environment.NewLine, lines);
            }

            object pacsValue;
            var pacs = steps.TryGetValue("pacs", out pacsValue) ? pacsValue as Dictionary<string, object> : null;
            if (pacs != null)
            {
                var ok = Convert.ToBoolean(pacs.ContainsKey("ok") ? pacs["ok"] : false);
                lines.Add(ok ? "[PASS] Metadata PACS" : "[FAIL] Metadata PACS");
                if (ok) lines.Add("        Storage DICOM dibaca ulang dan indeks PACS diperbarui.");
                else lines.Add("        " + Convert.ToString(pacs.ContainsKey("error") ? pacs["error"] : "gagal"));
            }

            object risValue;
            var ris = steps.TryGetValue("ris", out risValue) ? risValue as Dictionary<string, object> : null;
            if (ris != null)
            {
                var ok = Convert.ToBoolean(ris.ContainsKey("ok") ? ris["ok"] : false);
                lines.Add(ok ? "[PASS] Order RIS" : "[FAIL] Order RIS");
                if (ok)
                {
                    var checkedCount = ris.ContainsKey("checked") ? ris["checked"] : null;
                    var completedCount = ris.ContainsKey("completed") ? ris["completed"] : null;
                    var passes = ris.ContainsKey("passes") ? ris["passes"] : null;
                    lines.Add("        Order diperiksa: " + checkedCount + " | ditandai selesai: " + completedCount
                        + " | " + passes + " pass");
                    if (Convert.ToInt64(completedCount ?? 0) == 0)
                    {
                        lines.Add("        Tidak ada order yang berubah - order SENT_TO_MWL belum ada");
                        lines.Add("        study-nya di PACS (modality belum mengirim).");
                    }
                }
                else lines.Add("        " + Convert.ToString(ris.ContainsKey("error") ? ris["error"] : "gagal"));
            }

            return string.Join(Environment.NewLine, lines);
        }

        private string FormatDuration(object milliseconds)
        {
            double ms;
            if (!double.TryParse(Convert.ToString(milliseconds), out ms)) return "-";
            if (ms < 1000) return Math.Round(ms) + " ms";
            var seconds = ms / 1000.0;
            if (seconds < 60) return Math.Round(seconds, 1) + " s";
            return Math.Floor(seconds / 60) + " m " + Math.Round(seconds % 60) + " s";
        }

        // The RIS backend port is whatever install-services.ps1 wrote (3001 by
        // default); read it back from the service environment when available so a
        // non-default port still works.
        private int ResolveRisPort(string installDir)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "nssm",
                    Arguments = "get VexaRISBackend AppEnvironmentExtra",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                using (var process = Process.Start(psi))
                {
                    var output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(5000);
                    var match = Regex.Match(output ?? string.Empty, @"(?:^|\s)PORT=(\d+)");
                    if (match.Success)
                    {
                        int port;
                        if (int.TryParse(match.Groups[1].Value, out port) && port > 0) return port;
                    }
                }
            }
            catch
            {
                // fall through to the default below
            }
            return 3001;
        }

        private void AddPortCheck(List<string> lines, HashSet<int> listeners, int port, string label, bool required)
        {
            lines.Add((listeners.Contains(port) ? "[PASS] " : required ? "[FAIL] " : "[WARN] ") + label + " | Port " + port + (listeners.Contains(port) ? " listening" : " not listening"));
        }

        private string PreflightHttp(string url, string label)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 2500;
                request.Method = "GET";
                using (var response = (HttpWebResponse)request.GetResponse()) return "[PASS] " + label + " | HTTP " + (int)response.StatusCode;
            }
            catch (WebException ex)
            {
                var response = ex.Response as HttpWebResponse;
                return response != null && (int)response.StatusCode < 500 ? "[PASS] " + label + " | HTTP " + (int)response.StatusCode : "[FAIL] " + label;
            }
            catch { return "[FAIL] " + label; }
        }

        private bool ValidateJsonFile(string path)
        {
            try { return File.Exists(path) && new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(File.ReadAllText(path)) != null; }
            catch { return false; }
        }

        private List<ConfigFileOption> ManagedConfigFiles()
        {
            return new List<ConfigFileOption>
            {
                new ConfigFileOption("RIS Backend", Path.Combine("RIS", "backend", "settings.json")),
                new ConfigFileOption("PACS", Path.Combine("PACS", "config", "default.json")),
                new ConfigFileOption("RIS Frontend", Path.Combine("RIS", "frontend", "public", "settings.json")),
                new ConfigFileOption("Legacy Viewer", Path.Combine("DESKTOP VIEWER", "public", "settings.json")),
                new ConfigFileOption("Server-rendered Viewer", Path.Combine("DESKTOP VIEWER SSR", "public", "settings.json")),
                new ConfigFileOption("Mobile Viewer", Path.Combine("MOBILITY VIEWER", "public", "settings.json"))
            };
        }

        private string SettingsBackupRoot() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "VEXAPACS", "config-backups"); }
        private string SettingsAuditPath() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "VEXAPACS", "logs", "settings-audit.log"); }

        private string BackupAllSettings(string reason)
        {
            try
            {
                var installDir = FindInstallDir();
                var target = Path.Combine(SettingsBackupRoot(), DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + reason);
                Directory.CreateDirectory(target);
                foreach (var option in ManagedConfigFiles())
                {
                    var source = Path.Combine(installDir, option.RelativePath);
                    if (!File.Exists(source)) continue;
                    var destination = Path.Combine(target, option.RelativePath);
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    File.Copy(source, destination, true);
                }
                WriteSettingsAudit("BACKUP", reason + " | " + target);
                if (diagnosticsOutput != null) diagnosticsOutput.Text = "Settings backup created:\r\n" + target;
                if (reason == "manual") MessageBox.Show(this, "Settings backup created successfully.", "Backup", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return target;
            }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "Backup Failed", MessageBoxButtons.OK, MessageBoxIcon.Error); return null; }
        }

        private void RestoreLatestSettingsBackup()
        {
            try
            {
                var root = SettingsBackupRoot();
                if (!Directory.Exists(root)) throw new InvalidOperationException("No settings backup is available.");
                var latest = new DirectoryInfo(root).GetDirectories().Where(item => !item.Name.EndsWith("-pre-restore", StringComparison.OrdinalIgnoreCase)).OrderByDescending(item => item.CreationTimeUtc).FirstOrDefault();
                if (latest == null) throw new InvalidOperationException("No settings backup is available.");
                if (MessageBox.Show(this, "Restore settings from the latest backup?\r\n\r\n" + latest.Name, "Restore Settings", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
                BackupAllSettings("pre-restore");
                var installDir = FindInstallDir();
                foreach (var option in ManagedConfigFiles())
                {
                    var source = Path.Combine(latest.FullName, option.RelativePath);
                    if (!File.Exists(source)) continue;
                    var destination = Path.Combine(installDir, option.RelativePath);
                    File.Copy(source, destination, true);
                }
                WriteSettingsAudit("RESTORE", latest.FullName);
                diagnosticsOutput.Text = "Settings restored from:\r\n" + latest.FullName + "\r\n\r\nRestart the affected services to activate the restored settings.";
                MessageBox.Show(this, "Settings restored. Restart the affected services to activate them.", "Restore Complete", MessageBoxButtons.OK, MessageBoxIcon.Information);
                LoadSelectedConfigFile();
            }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "Restore Failed", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }

        private void WriteSettingsAudit(string action, string detail)
        {
            try
            {
                var path = SettingsAuditPath();
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var identity = WindowsIdentity.GetCurrent();
                var user = identity == null ? Environment.UserName : identity.Name;
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\t" + user + "\t" + action + "\t" + detail.Replace('\r', ' ').Replace('\n', ' ') + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        private void BuildStructuredConfigFields()
        {
            configFieldsPanel.SuspendLayout();
            configFieldsPanel.Controls.Clear();
            configFieldControls.Clear();
            viewerButtonControls.Clear();
            viewerButtonLabelControls.Clear();
            viewerButtonUsernameControls.Clear();
            viewerButtonPasswordControls.Clear();
            viewerButtonTestControls.Clear();
            orderOutUrlPreviewLabel = null;
            var table = new TableLayoutPanel
            {
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Left = 0,
                Top = 0,
                Width = Math.Max(700, configFieldsPanel.ClientSize.Width - 4),
                ColumnCount = 2,
                Padding = new Padding(14),
                BackColor = Color.White,
                ForeColor = Color.FromArgb(30, 41, 59)
            };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 300));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            var selected = SelectedConfigFile();
            if (selected != null && !string.IsNullOrWhiteSpace(selected.ViewerId))
            {
                var viewers = activeConfigDocument.ContainsKey("viewers") ? activeConfigDocument["viewers"] as object[] : null;
                var found = false;
                if (viewers != null)
                {
                    for (var index = 0; index < viewers.Length; index++)
                    {
                        var viewer = viewers[index] as Dictionary<string, object>;
                        if (viewer == null || !viewer.ContainsKey("id") || !string.Equals(Convert.ToString(viewer["id"]), selected.ViewerId, StringComparison.OrdinalIgnoreCase)) continue;
                        AddSectionHeader(table, selected.Label);
                        AddConfigFields(table, viewer, "viewers." + index, selected.Label);
                        found = true;
                        break;
                    }
                }
                if (!found) AddReadOnlyConfigRow(table, selected.Label, "Viewer registration was not found.");
            }
            else if (selected != null && string.Equals(selected.Label, "RIS & Facility", StringComparison.OrdinalIgnoreCase))
            {
                BuildRisSettingsFields(table);
            }
            else AddConfigFields(table, activeConfigDocument, string.Empty, string.Empty);
            configFieldsPanel.Controls.Add(table);
            configFieldsPanel.AutoScrollPosition = Point.Empty;
            configFieldsPanel.ResumeLayout();
        }

        private void BuildRisSettingsFields(TableLayoutPanel table)
        {
            AddSectionHeader(table, "Facility Identity");
            AddConfiguredField(table, "facility.name", "Facility Name");
            AddConfiguredField(table, "facility.address", "Facility Address");
            AddConfiguredField(table, "appVersion", "Application Version");

            AddSectionHeader(table, "Public Access");
            AddConfiguredField(table, "publicBaseUrl", "Public Domain / IP Address");
            AddConfiguredField(table, "publicStudyPath", "Public Study Path");
            AddConfiguredField(table, "viewerTokenPath", "Viewer Token Path");
            AddConfiguredField(table, "viewerAccessToken.expiresInDays", "Access Token Validity (Days)");
            AddOrderOutUrlPreviewRow(table);

            AddSectionHeader(table, "Primary Viewer & Security");
            AddConfiguredField(table, "pacsViewerEnabled", "Enable Primary Viewer");
            AddConfiguredField(table, "pacsViewerBaseUrl", "Viewer Base URL");
            AddConfiguredField(table, "viewerLaunchBaseUrl", "Viewer Launch URL");
            AddConfiguredField(table, "pacsViewerLaunchEndpoint", "Launch API Endpoint");
            AddConfiguredField(table, "pacsViewerHeaderName", "Security Header Name");
            AddConfiguredField(table, "pacsViewerSharedSecret", "Viewer Shared Secret");

            AddSectionHeader(table, "SIMRS Viewer Links");
            AddReadOnlyConfigRow(table, "Permission Source", "Permissions are taken from the matching account in each viewer's Access Management.");
            AddViewerButtonHeader(table);
            for (var slot = 1; slot <= 6; slot++) AddViewerButtonField(table, slot);

            AddSectionHeader(table, "SIMRS Integration");
            AddConfiguredField(table, "simrsDbBridge.enabled", "Enable Integration Bridge");
            AddConfiguredField(table, "simrsDbBridge.mode", "Integration Method");
            AddConfiguredField(table, "simrsDbBridge.pollIntervalMs", "Polling Interval (Milliseconds)");
            AddConfiguredField(table, "simrsDbBridge.batchSize", "Maximum Orders per Batch");
            AddConfiguredField(table, "simrsDbBridge.risApi.baseUrl", "RIS API Base URL");
            AddConfiguredField(table, "simrsDbBridge.risApi.apiKey", "RIS API Key");

            AddSectionHeader(table, "Order In Database");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderIn.enabled", "Enable Order In");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderIn.table", "Staging Table");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderIn.db.host", "Database Host");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderIn.db.port", "Database Port");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderIn.db.database", "Database Name");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderIn.db.user", "Database User");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderIn.db.password", "Database Password");
            AddDatabaseTestRow(table, "orderIn", "Test Order In Connection");

            AddSectionHeader(table, "Order Out Database");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.enabled", "Enable Order Out");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.table", "Staging Table");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.db.host", "Database Host");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.db.port", "Database Port");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.db.database", "Database Name");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.db.user", "Database User");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.db.password", "Database Password");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.updateRisFilter", "RIS Update Filter");
            AddConfiguredField(table, "simrsDbBridge.postgres.orderOut.ackInternalAfterPush", "Acknowledge After Push");
            AddDatabaseTestRow(table, "orderOut", "Test Order Out Connection");

            AddSectionHeader(table, "WhatsApp Distribution");
            AddConfiguredField(table, "whatsapp.enabled", "Enable WhatsApp");
            AddConfiguredField(table, "whatsapp.provider", "Provider");
            AddConfiguredField(table, "whatsapp.phoneCountryCode", "Default Country Code");
            AddConfiguredField(table, "whatsapp.fallbackToWeb", "Fallback to WhatsApp Web");

            AddSectionHeader(table, "WAHA Connection");
            AddConfiguredField(table, "whatsapp.baseUrl", "Provider Base URL");
            AddConfiguredField(table, "whatsapp.session", "Session Name");
            AddConfiguredField(table, "whatsapp.apiKey", "Provider API Key");
            AddConfiguredField(table, "whatsapp.sendTextPath", "Send Text Path");

            AddSectionHeader(table, "Custom REST API");
            AddReadOnlyConfigRow(table, "Available Placeholders", "{{number}}, {{message}}, {{apiKey}}, {{session}}, {{chatId}}, {{numberUrl}}, {{messageUrl}}");
            AddConfiguredField(table, "whatsapp.custom.endpointUrl", "Endpoint URL");
            AddConfiguredField(table, "whatsapp.custom.method", "HTTP Method");
            AddMultilineConfiguredField(table, "whatsapp.custom.headersTemplate", "Headers JSON Template", 78);
            AddMultilineConfiguredField(table, "whatsapp.custom.bodyTemplate", "Request Body Template", 100);
            AddConfiguredField(table, "whatsapp.custom.successJsonPath", "Success JSON Path (Optional)");
            AddConfiguredField(table, "whatsapp.custom.successExpectedValue", "Expected Success Value (Optional)");
            AddConfiguredField(table, "whatsapp.custom.timeoutMs", "Request Timeout (Milliseconds)");
        }

        private void AddConfiguredField(TableLayoutPanel table, string path, string label)
        {
            object value;
            if (!TryGetConfigValue(activeConfigDocument, path.Split('.'), 0, out value)) return;
            AddConfigFieldRow(table, path, label, value);
        }

        private void AddMultilineConfiguredField(TableLayoutPanel table, string path, string labelText, int height)
        {
            object value;
            if (!TryGetConfigValue(activeConfigDocument, path.Split('.'), 0, out value)) return;
            var label = new Label
            {
                Text = labelText,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.TopLeft,
                Margin = new Padding(8, 8, 8, 5),
                ForeColor = Color.FromArgb(30, 41, 59)
            };
            var input = new TextBox
            {
                Text = Convert.ToString(value, CultureInfo.InvariantCulture),
                Dock = DockStyle.Fill,
                Multiline = true,
                ScrollBars = ScrollBars.Vertical,
                AcceptsReturn = true,
                WordWrap = true,
                Height = height,
                Margin = new Padding(3, 4, 12, 4),
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 9F)
            };
            input.Tag = typeof(string);
            configFieldControls[path] = input;
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, height + 10));
            table.Controls.Add(label, 0, table.RowCount);
            table.Controls.Add(input, 1, table.RowCount);
            table.RowCount++;
        }

        private void AddViewerButtonField(TableLayoutPanel table, int slot)
        {
            var key = "urllink" + slot;
            var links = activeConfigDocument.ContainsKey("orderOutLinks") ? activeConfigDocument["orderOutLinks"] as Dictionary<string, object> : null;
            var current = links != null && links.ContainsKey(key) ? links[key] as Dictionary<string, object> : null;
            var launchUser = current != null && current.ContainsKey("launchUser") ? current["launchUser"] as Dictionary<string, object> : null;
            var currentEnabled = current != null && (!current.ContainsKey("enabled") || Convert.ToBoolean(current["enabled"]));
            var currentType = current != null && current.ContainsKey("type") ? Convert.ToString(current["type"]) : "none";
            var currentViewerId = current != null && current.ContainsKey("viewerId") ? Convert.ToString(current["viewerId"]) : string.Empty;
            var select = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, Margin = new Padding(3, 4, 12, 4) };
            select.Items.Add(new ViewerButtonOption("Disabled", "none", string.Empty));
            select.Items.Add(new ViewerButtonOption("Primary Diagnostic Viewer (" + ViewerRuntimeStatus("vexa-pacs") + ")", "viewer", "vexa-pacs"));
            select.Items.Add(new ViewerButtonOption("Mobile Viewer (" + ViewerRuntimeStatus("vexa-mobile") + ")", "viewer", "vexa-mobile"));
            select.Items.Add(new ViewerButtonOption("ECG Viewer (" + ViewerRuntimeStatus("ecg-viewer") + ")", "viewer", "ecg-viewer"));
            select.Items.Add(new ViewerButtonOption("Patient Public Study", "publicStudy", string.Empty));
            select.SelectedIndex = 0;
            if (currentEnabled)
            {
                for (var index = 1; index < select.Items.Count; index++)
                {
                    var option = select.Items[index] as ViewerButtonOption;
                    if (option != null && string.Equals(option.Type, currentType, StringComparison.OrdinalIgnoreCase) && string.Equals(option.ViewerId, currentViewerId, StringComparison.OrdinalIgnoreCase)) { select.SelectedIndex = index; break; }
                }
            }
            viewerButtonControls[key] = select;
            var labelText = current != null && current.ContainsKey("label") ? Convert.ToString(current["label"]) : "Button " + slot;
            var customLabel = new TextBox { Text = labelText, Dock = DockStyle.Fill, Margin = new Padding(8, 4, 0, 4) };
            viewerButtonLabelControls[key] = customLabel;
            var host = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2, RowCount = 1, Margin = new Padding(0) };
            host.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62));
            host.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
            host.Controls.Add(select, 0, 0);
            host.Controls.Add(customLabel, 1, 0);
            var label = new Label { Text = "Button " + slot, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(8, 5, 8, 5), ForeColor = Color.FromArgb(30, 41, 59) };
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(label, 0, table.RowCount);
            table.Controls.Add(host, 1, table.RowCount);
            table.RowCount++;

            var username = new TextBox
            {
                Text = launchUser != null && launchUser.ContainsKey("username") ? Convert.ToString(launchUser["username"]) : string.Empty,
                Dock = DockStyle.Fill,
                Margin = new Padding(0, 2, 8, 2),
                BorderStyle = BorderStyle.FixedSingle
            };
            var password = new TextBox
            {
                Text = launchUser != null && launchUser.ContainsKey("password") ? Convert.ToString(launchUser["password"]) : string.Empty,
                UseSystemPasswordChar = true,
                Dock = DockStyle.Fill,
                Margin = new Padding(0, 2, 0, 2),
                BorderStyle = BorderStyle.FixedSingle
            };
            var reveal = new Button { Text = "Show", Dock = DockStyle.Fill, Height = 28, Margin = new Padding(5, 0, 0, 0) };
            reveal.Click += delegate
            {
                password.UseSystemPasswordChar = !password.UseSystemPasswordChar;
                reveal.Text = password.UseSystemPasswordChar ? "Show" : "Hide";
            };
            var passwordHost = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = false, Height = 30, ColumnCount = 2, RowCount = 1, Margin = new Padding(0) };
            passwordHost.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            passwordHost.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 68));
            passwordHost.Controls.Add(password, 0, 0);
            passwordHost.Controls.Add(reveal, 1, 0);

            var testButton = Button("Test Account", async delegate { await TestViewerButtonAccount(key); });
            testButton.Dock = DockStyle.Fill;
            testButton.Margin = new Padding(8, 1, 0, 1);
            var accountHost = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 3, RowCount = 2, Margin = new Padding(3, 0, 0, 10) };
            accountHost.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
            accountHost.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42));
            accountHost.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20));
            accountHost.RowStyles.Add(new RowStyle(SizeType.Absolute, 20));
            accountHost.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
            accountHost.Controls.Add(new Label { Text = "Integration Username", Dock = DockStyle.Fill, ForeColor = Color.DimGray, Margin = new Padding(0, 0, 0, 2) }, 0, 0);
            accountHost.Controls.Add(new Label { Text = "Integration Password", Dock = DockStyle.Fill, ForeColor = Color.DimGray, Margin = new Padding(0, 0, 0, 2) }, 1, 0);
            accountHost.Controls.Add(new Label { Text = "Validation", Dock = DockStyle.Fill, ForeColor = Color.DimGray, Margin = new Padding(8, 0, 0, 2) }, 2, 0);
            accountHost.Controls.Add(username, 0, 1);
            accountHost.Controls.Add(passwordHost, 1, 1);
            accountHost.Controls.Add(testButton, 2, 1);
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(new Label { Text = "Launch Account", Dock = DockStyle.Fill, TextAlign = ContentAlignment.TopLeft, Margin = new Padding(28, 7, 8, 5), ForeColor = Color.DimGray }, 0, table.RowCount);
            table.Controls.Add(accountHost, 1, table.RowCount);
            table.RowCount++;

            viewerButtonUsernameControls[key] = username;
            viewerButtonPasswordControls[key] = password;
            viewerButtonTestControls[key] = testButton;
            select.SelectedIndexChanged += delegate { UpdateViewerButtonCredentialState(key); };
            UpdateViewerButtonCredentialState(key);
        }

        private void AddViewerButtonHeader(TableLayoutPanel table)
        {
            var host = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2, RowCount = 1, Margin = new Padding(0) };
            host.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62));
            host.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
            host.Controls.Add(new Label { Text = "Viewer Target", Dock = DockStyle.Fill, ForeColor = Color.DimGray, Margin = new Padding(3, 0, 0, 2) }, 0, 0);
            host.Controls.Add(new Label { Text = "Button Label", Dock = DockStyle.Fill, ForeColor = Color.DimGray, Margin = new Padding(8, 0, 0, 2) }, 1, 0);
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(new Label { Text = "", AutoSize = true }, 0, table.RowCount);
            table.Controls.Add(host, 1, table.RowCount);
            table.RowCount++;
        }

        private void AddOrderOutUrlPreviewRow(TableLayoutPanel table)
        {
            orderOutUrlPreviewLabel = new Label
            {
                Dock = DockStyle.Fill,
                AutoSize = true,
                ForeColor = Color.FromArgb(15, 76, 92),
                Font = new Font("Segoe UI Semibold", 9F),
                Margin = new Padding(3, 7, 12, 9)
            };
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(new Label { Text = "Generated Order Out Link", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(8, 5, 8, 9), ForeColor = Color.FromArgb(30, 41, 59) }, 0, table.RowCount);
            table.Controls.Add(orderOutUrlPreviewLabel, 1, table.RowCount);
            table.RowCount++;
            TextBox publicBaseControl;
            TextBox tokenPathControl;
            if (configFieldControls.ContainsKey("publicBaseUrl") && (publicBaseControl = configFieldControls["publicBaseUrl"] as TextBox) != null)
                publicBaseControl.TextChanged += delegate { UpdateOrderOutUrlPreview(); };
            if (configFieldControls.ContainsKey("viewerTokenPath") && (tokenPathControl = configFieldControls["viewerTokenPath"] as TextBox) != null)
                tokenPathControl.TextChanged += delegate { UpdateOrderOutUrlPreview(); };
            UpdateOrderOutUrlPreview();
        }

        private void UpdateOrderOutUrlPreview()
        {
            if (orderOutUrlPreviewLabel == null) return;
            var publicBase = configFieldControls.ContainsKey("publicBaseUrl") && configFieldControls["publicBaseUrl"] is TextBox
                ? ((TextBox)configFieldControls["publicBaseUrl"]).Text.Trim().TrimEnd('/')
                : string.Empty;
            var tokenPath = configFieldControls.ContainsKey("viewerTokenPath") && configFieldControls["viewerTokenPath"] is TextBox
                ? ((TextBox)configFieldControls["viewerTokenPath"]).Text.Trim()
                : "/viewer/token";
            if (!tokenPath.StartsWith("/")) tokenPath = "/" + tokenPath;
            orderOutUrlPreviewLabel.Text = publicBase + tokenPath.TrimEnd('/') + "/<secure-token>/urllink1";
        }

        private bool ViewerButtonRequiresAccount(ViewerButtonOption option)
        {
            return option != null && string.Equals(option.Type, "viewer", StringComparison.OrdinalIgnoreCase) &&
                (string.Equals(option.ViewerId, "vexa-pacs", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(option.ViewerId, "vexa-mobile", StringComparison.OrdinalIgnoreCase));
        }

        private void UpdateViewerButtonCredentialState(string key)
        {
            if (!viewerButtonControls.ContainsKey(key)) return;
            var option = viewerButtonControls[key].SelectedItem as ViewerButtonOption;
            var enabled = ViewerButtonRequiresAccount(option);
            if (viewerButtonUsernameControls.ContainsKey(key)) viewerButtonUsernameControls[key].Enabled = enabled;
            if (viewerButtonPasswordControls.ContainsKey(key)) viewerButtonPasswordControls[key].Enabled = enabled;
            if (viewerButtonTestControls.ContainsKey(key)) viewerButtonTestControls[key].Enabled = enabled;
        }

        private async Task TestViewerButtonAccount(string key)
        {
            try
            {
                var option = viewerButtonControls.ContainsKey(key) ? viewerButtonControls[key].SelectedItem as ViewerButtonOption : null;
                if (!ViewerButtonRequiresAccount(option)) throw new InvalidOperationException("This viewer does not require an integration account.");
                var username = viewerButtonUsernameControls[key].Text.Trim();
                var password = viewerButtonPasswordControls[key].Text;
                if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password)) throw new InvalidOperationException("Enter the integration username and password first.");
                var port = string.Equals(option.ViewerId, "vexa-mobile", StringComparison.OrdinalIgnoreCase) ? 5992 : 5994;
                configEditorStatus.Text = "Testing " + key + " viewer account...";
                configEditorStatus.ForeColor = Color.DarkGoldenrod;
                await Task.Run(delegate
                {
                    var viewerBaseUrl = "http://127.0.0.1:" + port;
                    var cookies = new CookieContainer();
                    var request = (HttpWebRequest)WebRequest.Create(viewerBaseUrl + "/api/auth/login");
                    request.Method = "POST";
                    request.ContentType = "application/json";
                    request.Timeout = 5000;
                    request.CookieContainer = cookies;
                    var serializer = new JavaScriptSerializer();
                    var bytes = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> { { "username", username }, { "password", password } }));
                    request.ContentLength = bytes.Length;
                    using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
                    using (var response = (HttpWebResponse)request.GetResponse())
                    {
                        if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300) throw new InvalidOperationException("Viewer rejected the account.");
                    }
                    try
                    {
                        var logout = (HttpWebRequest)WebRequest.Create(viewerBaseUrl + "/api/auth/logout");
                        logout.Method = "POST";
                        logout.ContentType = "application/json";
                        logout.Timeout = 2500;
                        logout.CookieContainer = cookies;
                        var emptyBody = Encoding.UTF8.GetBytes("{}");
                        logout.ContentLength = emptyBody.Length;
                        using (var stream = logout.GetRequestStream()) stream.Write(emptyBody, 0, emptyBody.Length);
                        using (logout.GetResponse()) { }
                    }
                    catch { }
                });
                configEditorStatus.Text = key + " account verified successfully against " + option.Label + ".";
                configEditorStatus.ForeColor = Color.SeaGreen;
                MessageBox.Show(this, "The integration account is valid and active.", "Viewer Account Test", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                configEditorStatus.Text = "Viewer account test failed.";
                configEditorStatus.ForeColor = Color.Firebrick;
                MessageBox.Show(this, ex is WebException ? "The viewer rejected the account or is unavailable." : ex.Message, "Viewer Account Test Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string ViewerRuntimeStatus(string viewerId)
        {
            var defaultPort = string.Equals(viewerId, "vexa-pacs", StringComparison.OrdinalIgnoreCase) ? 5994 : string.Equals(viewerId, "vexa-mobile", StringComparison.OrdinalIgnoreCase) ? 5992 : 7771;
            try
            {
                var listeners = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners();
                return listeners.Any(endpoint => endpoint.Port == defaultPort) ? "Online" : "Offline";
            }
            catch { return "Unknown"; }
        }

        private bool TryGetConfigValue(object root, string[] path, int index, out object value)
        {
            value = null;
            var dictionary = root as Dictionary<string, object>;
            object next;
            if (dictionary == null || !dictionary.TryGetValue(path[index], out next)) return false;
            if (index == path.Length - 1) { value = next; return true; }
            return TryGetConfigValue(next, path, index + 1, out value);
        }

        private void AddDatabaseTestRow(TableLayoutPanel table, string direction, string buttonText)
        {
            var testButton = Button(buttonText, async delegate { await TestDatabaseConnection(direction); });
            testButton.Width = 240;
            var host = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0) };
            host.Controls.Add(testButton);
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(new Label { Text = "Connection Test", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(8, 8, 8, 5), ForeColor = Color.FromArgb(30, 41, 59) }, 0, table.RowCount);
            table.Controls.Add(host, 1, table.RowCount);
            table.RowCount++;
        }

        private async Task TestDatabaseConnection(string direction)
        {
            try
            {
                ApplyStructuredConfigFields();
                object dbValue;
                var path = "simrsDbBridge.postgres." + direction + ".db";
                if (!TryGetConfigValue(activeConfigDocument, path.Split('.'), 0, out dbValue)) throw new InvalidOperationException("Database settings are unavailable.");
                var source = dbValue as Dictionary<string, object>;
                if (source == null) throw new InvalidOperationException("Database settings are invalid.");
                var payload = new Dictionary<string, object>(source, StringComparer.OrdinalIgnoreCase);
                payload["driver"] = CurrentIntegrationDriver();
                var installDir = FindInstallDir();
                var scriptPath = Path.Combine(installDir, "tools", "simrs-db-bridge", "test-connection-cli.js");
                if (!File.Exists(scriptPath)) throw new FileNotFoundException("Database test component was not found.", scriptPath);
                var start = new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = "\"" + scriptPath + "\"",
                    WorkingDirectory = Path.GetDirectoryName(scriptPath),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                configEditorStatus.Text = "Testing " + (direction == "orderOut" ? "Order Out" : "Order In") + " database connection...";
                configEditorStatus.ForeColor = Color.DarkGoldenrod;
                using (var process = Process.Start(start))
                {
                    var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                    await process.StandardInput.WriteAsync(serializer.Serialize(payload));
                    process.StandardInput.Close();
                    var outputTask = process.StandardOutput.ReadToEndAsync();
                    var errorTask = process.StandardError.ReadToEndAsync();
                    await Task.Run(delegate { process.WaitForExit(); });
                    var output = await outputTask;
                    var error = await errorTask;
                    if (process.ExitCode != 0) throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? "Connection failed." : error.Trim());
                    configEditorStatus.Text = "Connection successful: " + payload["driver"] + " / " + (direction == "orderOut" ? "Order Out" : "Order In");
                    configEditorStatus.ForeColor = Color.SeaGreen;
                    MessageBox.Show(this, "Database connection successful.", "Connection Test", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                configEditorStatus.Text = "Connection failed: " + ex.Message;
                configEditorStatus.ForeColor = Color.Firebrick;
                MessageBox.Show(this, ex.Message, "Connection Test Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void AddConfigFields(TableLayoutPanel table, Dictionary<string, object> values, string pathPrefix, string section)
        {
            foreach (var pair in values)
            {
                var path = string.IsNullOrWhiteSpace(pathPrefix) ? pair.Key : pathPrefix + "." + pair.Key;
                var nested = pair.Value as Dictionary<string, object>;
                if (nested != null)
                {
                    AddSectionHeader(table, HumanizeSetting(pair.Key));
                    AddConfigFields(table, nested, path, pair.Key);
                    continue;
                }
                if (pair.Value is object[] || pair.Value is System.Collections.ArrayList)
                {
                    AddReadOnlyConfigRow(table, HumanizeSetting(pair.Key), "Managed list (configured by the related system module)");
                    continue;
                }
                AddConfigFieldRow(table, path, HumanizeSetting(pair.Key), pair.Value);
            }
        }

        private void AddSectionHeader(TableLayoutPanel table, string title)
        {
            var label = new Label
            {
                Text = title,
                AutoSize = true,
                Font = new Font("Segoe UI Semibold", 10F),
                ForeColor = Color.FromArgb(15, 76, 92),
                Margin = new Padding(0, 16, 0, 6)
            };
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(label, 0, table.RowCount);
            table.SetColumnSpan(label, 2);
            table.RowCount++;
        }

        private void AddConfigFieldRow(TableLayoutPanel table, string path, string labelText, object value)
        {
            var label = new Label
            {
                Text = labelText,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Margin = new Padding(8, 5, 8, 5),
                ForeColor = Color.FromArgb(30, 41, 59)
            };
            Control input;
            if (string.Equals(path, "whatsapp.provider", StringComparison.OrdinalIgnoreCase))
            {
                var select = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, Margin = new Padding(3, 4, 12, 4) };
                select.Items.Add(new ConfigChoiceOption("WAHA", "waha"));
                select.Items.Add(new ConfigChoiceOption("Custom REST API", "custom"));
                var current = Convert.ToString(value).Trim().ToLowerInvariant();
                select.SelectedIndex = current == "custom" || current == "custom-rest" || current == "webhook" ? 1 : 0;
                input = select;
            }
            else if (string.Equals(path, "whatsapp.custom.method", StringComparison.OrdinalIgnoreCase))
            {
                var select = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, Margin = new Padding(3, 4, 12, 4) };
                foreach (var method in new[] { "POST", "GET", "PUT", "PATCH" }) select.Items.Add(new ConfigChoiceOption(method, method));
                var current = Convert.ToString(value).Trim().ToUpperInvariant();
                select.SelectedIndex = Math.Max(0, Array.FindIndex(new[] { "POST", "GET", "PUT", "PATCH" }, item => item == current));
                input = select;
            }
            else if (string.Equals(path, "simrsDbBridge.mode", StringComparison.OrdinalIgnoreCase))
            {
                var select = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, Margin = new Padding(3, 4, 12, 4) };
                select.Items.Add(new IntegrationModeOption("API Only", "api-only", string.Empty));
                select.Items.Add(new IntegrationModeOption("PostgreSQL Staging", "api-and-db", "postgresql"));
                select.Items.Add(new IntegrationModeOption("MySQL Staging", "api-and-db", "mysql"));
                select.Items.Add(new IntegrationModeOption("MariaDB Staging", "api-and-db", "mariadb"));
                select.Items.Add(new IntegrationModeOption("Microsoft SQL Server Staging", "api-and-db", "sqlserver"));
                var currentMode = Convert.ToString(value);
                select.SelectedIndex = 0;
                if (!string.Equals(currentMode, "api-only", StringComparison.OrdinalIgnoreCase))
                {
                    var currentDriver = CurrentIntegrationDriver();
                    for (var optionIndex = 1; optionIndex < select.Items.Count; optionIndex++)
                    {
                        var option = select.Items[optionIndex] as IntegrationModeOption;
                        if (option != null && string.Equals(option.Driver, currentDriver, StringComparison.OrdinalIgnoreCase)) { select.SelectedIndex = optionIndex; break; }
                    }
                }
                input = select;
            }
            else if (value is bool)
            {
                input = new CheckBox { Checked = (bool)value, Text = (bool)value ? "Enabled" : "Disabled", AutoSize = true, Margin = new Padding(3, 7, 3, 7), ForeColor = Color.FromArgb(30, 41, 59) };
                ((CheckBox)input).CheckedChanged += delegate { ((CheckBox)input).Text = ((CheckBox)input).Checked ? "Enabled" : "Disabled"; };
            }
            else
            {
                var textBox = new TextBox { Text = Convert.ToString(value, CultureInfo.InvariantCulture), Dock = DockStyle.Fill, Margin = new Padding(3, 4, 12, 4), ForeColor = Color.Black, BackColor = Color.White, BorderStyle = BorderStyle.FixedSingle };
                var lower = path.ToLowerInvariant();
                if (lower.Contains("password") || lower.Contains("secret") || lower.Contains("apikey") || lower.Contains("accesskey"))
                {
                    textBox.UseSystemPasswordChar = true;
                    var host = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = false, Height = 30, MinimumSize = new Size(0, 30), MaximumSize = new Size(0, 30), ColumnCount = 2, RowCount = 1, Margin = new Padding(3, 2, 12, 2) };
                    host.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
                    host.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 72));
                    host.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
                    textBox.Margin = new Padding(0, 2, 0, 2);
                    var reveal = new Button { Text = "Show", Dock = DockStyle.Fill, Height = 28, Margin = new Padding(5, 0, 0, 0) };
                    reveal.Click += delegate { textBox.UseSystemPasswordChar = !textBox.UseSystemPasswordChar; reveal.Text = textBox.UseSystemPasswordChar ? "Show" : "Hide"; };
                    host.Controls.Add(textBox, 0, 0);
                    host.Controls.Add(reveal, 1, 0);
                    input = textBox;
                    table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                    table.Controls.Add(label, 0, table.RowCount);
                    table.Controls.Add(host, 1, table.RowCount);
                    configFieldControls[path] = input;
                    input.Tag = value == null ? typeof(string) : value.GetType();
                    table.RowCount++;
                    return;
                }
                input = textBox;
            }
            input.Tag = value == null ? typeof(string) : value.GetType();
            configFieldControls[path] = input;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(label, 0, table.RowCount);
            table.Controls.Add(input, 1, table.RowCount);
            table.RowCount++;
        }

        private void AddReadOnlyConfigRow(TableLayoutPanel table, string labelText, string value)
        {
            var label = new Label { Text = labelText, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(8, 5, 8, 5), ForeColor = Color.FromArgb(30, 41, 59) };
            var status = new Label { Text = value, Dock = DockStyle.Fill, ForeColor = Color.DimGray, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(3, 5, 12, 5) };
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(label, 0, table.RowCount);
            table.Controls.Add(status, 1, table.RowCount);
            table.RowCount++;
        }

        private void ApplyStructuredConfigFields()
        {
            if (activeConfigDocument == null) throw new InvalidOperationException("No configuration is loaded.");
            ApplyViewerButtonFields();
            foreach (var pair in configFieldControls)
            {
                object value;
                var check = pair.Value as CheckBox;
                if (check != null) value = check.Checked;
                else if (pair.Value is ComboBox)
                {
                    var selectedItem = ((ComboBox)pair.Value).SelectedItem;
                    var integration = selectedItem as IntegrationModeOption;
                    var choice = selectedItem as ConfigChoiceOption;
                    if (integration != null)
                    {
                        value = integration.Mode;
                        ConfigureIntegrationConnector(integration);
                    }
                    else if (choice != null) value = choice.Value;
                    else throw new InvalidOperationException("Select a value for " + pair.Key + ".");
                }
                else
                {
                    var text = ((TextBox)pair.Value).Text.Trim();
                    var type = pair.Value.Tag as Type ?? typeof(string);
                    if (type == typeof(int)) value = int.Parse(text, CultureInfo.InvariantCulture);
                    else if (type == typeof(long)) value = long.Parse(text, CultureInfo.InvariantCulture);
                    else if (type == typeof(decimal)) value = decimal.Parse(text, CultureInfo.InvariantCulture);
                    else if (type == typeof(double)) value = double.Parse(text, CultureInfo.InvariantCulture);
                    else value = text;
                }
                SetConfigValue(activeConfigDocument, pair.Key.Split('.'), 0, value);
            }
        }

        private void ApplyViewerButtonFields()
        {
            if (viewerButtonControls.Count == 0) return;
            var links = activeConfigDocument.ContainsKey("orderOutLinks") ? activeConfigDocument["orderOutLinks"] as Dictionary<string, object> : null;
            if (links == null) throw new InvalidOperationException("Viewer button settings are unavailable.");
            var publicBaseUrl = configFieldControls.ContainsKey("publicBaseUrl") && configFieldControls["publicBaseUrl"] is TextBox
                ? ((TextBox)configFieldControls["publicBaseUrl"]).Text.Trim()
                : string.Empty;
            Uri parsedPublicBaseUrl;
            if (!Uri.TryCreate(publicBaseUrl, UriKind.Absolute, out parsedPublicBaseUrl) ||
                (parsedPublicBaseUrl.Scheme != Uri.UriSchemeHttp && parsedPublicBaseUrl.Scheme != Uri.UriSchemeHttps))
                throw new InvalidOperationException("Public Domain / IP Address must be a complete HTTP or HTTPS URL, for example https://pacs.hospital.id.");
            foreach (var pair in viewerButtonControls)
            {
                var option = pair.Value.SelectedItem as ViewerButtonOption;
                if (option == null) throw new InvalidOperationException("Select a viewer for " + pair.Key + ".");
                var link = links.ContainsKey(pair.Key) ? links[pair.Key] as Dictionary<string, object> : null;
                if (link == null) { link = new Dictionary<string, object>(); links[pair.Key] = link; }
                link["enabled"] = !string.Equals(option.Type, "none", StringComparison.OrdinalIgnoreCase);
                link["type"] = option.Type;
                if (string.Equals(option.Type, "viewer", StringComparison.OrdinalIgnoreCase))
                {
                    link["viewerId"] = option.ViewerId;
                    link["role"] = "clinician";
                    var customLabel = viewerButtonLabelControls.ContainsKey(pair.Key) ? viewerButtonLabelControls[pair.Key].Text.Trim() : string.Empty;
                    link["label"] = string.IsNullOrWhiteSpace(customLabel) ? (option.ViewerId == "vexa-pacs" ? "Diagnostic Viewer" : option.ViewerId == "vexa-mobile" ? "Mobile Viewer" : "ECG Viewer") : customLabel;
                    if (option.ViewerId == "ecg-viewer") link["onlyForModalities"] = new object[] { "ECG" };
                    else link.Remove("onlyForModalities");
                    if (ViewerButtonRequiresAccount(option))
                    {
                        var username = viewerButtonUsernameControls.ContainsKey(pair.Key) ? viewerButtonUsernameControls[pair.Key].Text.Trim() : string.Empty;
                        var password = viewerButtonPasswordControls.ContainsKey(pair.Key) ? viewerButtonPasswordControls[pair.Key].Text : string.Empty;
                        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
                            throw new InvalidOperationException(pair.Key + " requires an integration username and password that match an active viewer account.");
                        var launchUser = link.ContainsKey("launchUser") ? link["launchUser"] as Dictionary<string, object> : null;
                        if (launchUser == null) launchUser = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                        launchUser["externalUserId"] = username;
                        launchUser["username"] = username;
                        launchUser["password"] = password;
                        launchUser["fullName"] = launchUser.ContainsKey("fullName") && !string.IsNullOrWhiteSpace(Convert.ToString(launchUser["fullName"]))
                            ? Convert.ToString(launchUser["fullName"])
                            : "SIMRS Viewer Integration";
                        link["launchUser"] = launchUser;
                    }
                    else link.Remove("launchUser");
                }
                else
                {
                    link.Remove("viewerId");
                    link.Remove("role");
                    link.Remove("onlyForModalities");
                    link.Remove("launchUser");
                    if (string.Equals(option.Type, "publicStudy", StringComparison.OrdinalIgnoreCase))
                    {
                        var customLabel = viewerButtonLabelControls.ContainsKey(pair.Key) ? viewerButtonLabelControls[pair.Key].Text.Trim() : string.Empty;
                        link["label"] = string.IsNullOrWhiteSpace(customLabel) ? "Patient Public Study" : customLabel;
                    }
                }
            }
        }

        private void ConfigureIntegrationConnector(IntegrationModeOption option)
        {
            if (option == null || activeConfigDocument == null || string.IsNullOrWhiteSpace(option.Driver)) return;
            var bridge = activeConfigDocument["simrsDbBridge"] as Dictionary<string, object>;
            var legacy = bridge == null ? null : bridge["postgres"] as Dictionary<string, object>;
            if (bridge == null || legacy == null) throw new InvalidOperationException("Integration database settings are unavailable.");
            bridge["enabled"] = true;
            bridge["connectors"] = new object[]
            {
                new Dictionary<string, object>
                {
                    { "id", option.Driver + "-default" },
                    { "name", option.Label },
                    { "enabled", true },
                    { "driver", option.Driver },
                    { "orderIn", legacy.ContainsKey("orderIn") ? legacy["orderIn"] : new Dictionary<string, object>() },
                    { "orderOut", legacy.ContainsKey("orderOut") ? legacy["orderOut"] : new Dictionary<string, object>() }
                }
            };
        }

        private string CurrentIntegrationDriver()
        {
            if (activeConfigDocument == null) return "postgresql";
            var bridge = activeConfigDocument.ContainsKey("simrsDbBridge") ? activeConfigDocument["simrsDbBridge"] as Dictionary<string, object> : null;
            var connectors = bridge != null && bridge.ContainsKey("connectors") ? bridge["connectors"] as object[] : null;
            if (connectors != null && connectors.Length > 0)
            {
                var connector = connectors[0] as Dictionary<string, object>;
                if (connector != null && connector.ContainsKey("driver")) return Convert.ToString(connector["driver"]);
            }
            return "postgresql";
        }

        private void SetConfigValue(object root, string[] path, int index, object value)
        {
            var dictionary = root as Dictionary<string, object>;
            if (dictionary != null)
            {
                if (index == path.Length - 1) { dictionary[path[index]] = value; return; }
                object next;
                if (!dictionary.TryGetValue(path[index], out next)) throw new InvalidOperationException("Setting path is unavailable: " + string.Join(".", path));
                SetConfigValue(next, path, index + 1, value);
                return;
            }
            var array = root as object[];
            int arrayIndex;
            if (array != null && int.TryParse(path[index], out arrayIndex) && arrayIndex >= 0 && arrayIndex < array.Length)
            {
                if (index == path.Length - 1) { array[arrayIndex] = value; return; }
                SetConfigValue(array[arrayIndex], path, index + 1, value);
                return;
            }
            throw new InvalidOperationException("Setting path is unavailable: " + string.Join(".", path));
        }

        private string HumanizeSetting(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return value;
            var spaced = Regex.Replace(value, "([a-z0-9])([A-Z])", "$1 $2");
            return char.ToUpperInvariant(spaced[0]) + spaced.Substring(1);
        }

        private Control BuildSystemMonitorPanel()
        {
            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 5,
                ColumnCount = 1,
                Padding = new Padding(12),
                BackColor = Color.FromArgb(10, 18, 32),
            };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 168));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 86));

            var toolbar = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                BackColor = Color.FromArgb(10, 18, 32),
            };
            toolbar.Controls.Add(Button("Refresh System", delegate { RefreshSystemMonitor(); }));
            toolbar.Controls.Add(Button("Open DATA", delegate { OpenPathOrInfo(currentDataPath, "DATA path is not available yet."); }));
            toolbar.Controls.Add(Button("Open Backup Root", delegate { OpenPathOrInfo(currentBackupRoot, "Backup root is not available yet."); }));
            toolbar.Controls.Add(Button("Export PDF Report", delegate { ExportSystemReport(); }));

            var cards = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(10, 18, 32),
                AutoScroll = true,
                WrapContents = true,
                FlowDirection = FlowDirection.LeftToRight,
            };
            cards.Controls.Add(BuildMetricCard("STORAGE", storageCardValue, storageCardHint, Color.FromArgb(34, 211, 238), storageProgress));
            cards.Controls.Add(BuildMetricCard("BACKUP", backupCardValue, backupCardHint, Color.FromArgb(168, 85, 247), null));
            cards.Controls.Add(BuildMetricCard("DATABASE", databaseCardValue, databaseCardHint, Color.FromArgb(34, 197, 94), null));
            cards.Controls.Add(BuildMetricCard("STUDIES", studyCardValue, studyCardHint, Color.FromArgb(251, 191, 36), null));

            systemSummaryLabel.Dock = DockStyle.Fill;
            systemSummaryLabel.Font = new Font("Segoe UI Semibold", 11F);
            systemSummaryLabel.ForeColor = Color.FromArgb(226, 232, 240);
            systemSummaryLabel.BackColor = Color.FromArgb(15, 23, 42);
            systemSummaryLabel.Padding = new Padding(14, 0, 14, 0);
            systemSummaryLabel.TextAlign = ContentAlignment.MiddleLeft;

            systemGrid.Dock = DockStyle.Fill;
            systemGrid.AllowUserToAddRows = false;
            systemGrid.AllowUserToDeleteRows = false;
            systemGrid.AllowUserToResizeRows = false;
            systemGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            systemGrid.BackgroundColor = Color.FromArgb(15, 23, 42);
            systemGrid.BorderStyle = BorderStyle.FixedSingle;
            systemGrid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
            systemGrid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.AutoSize;
            systemGrid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(30, 41, 59);
            systemGrid.ColumnHeadersDefaultCellStyle.ForeColor = Color.FromArgb(226, 232, 240);
            systemGrid.ColumnHeadersDefaultCellStyle.SelectionBackColor = Color.FromArgb(30, 41, 59);
            systemGrid.DefaultCellStyle.BackColor = Color.FromArgb(15, 23, 42);
            systemGrid.DefaultCellStyle.ForeColor = Color.FromArgb(203, 213, 225);
            systemGrid.DefaultCellStyle.SelectionBackColor = Color.FromArgb(14, 116, 144);
            systemGrid.DefaultCellStyle.SelectionForeColor = Color.White;
            systemGrid.EnableHeadersVisualStyles = false;
            systemGrid.GridColor = Color.FromArgb(51, 65, 85);
            systemGrid.MultiSelect = false;
            systemGrid.ReadOnly = true;
            systemGrid.RowHeadersVisible = false;
            systemGrid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            systemGrid.Columns.Add("Metric", "Metric");
            systemGrid.Columns.Add("Value", "Value");
            systemGrid.Columns.Add("Notes", "Notes");
            systemGrid.Columns["Metric"].FillWeight = 110;
            systemGrid.Columns["Value"].FillWeight = 110;
            systemGrid.Columns["Notes"].FillWeight = 220;

            systemRecommendationLabel.Dock = DockStyle.Fill;
            systemRecommendationLabel.Font = new Font("Segoe UI", 9.5F);
            systemRecommendationLabel.ForeColor = Color.FromArgb(219, 234, 254);
            systemRecommendationLabel.BackColor = Color.FromArgb(8, 47, 73);
            systemRecommendationLabel.Padding = new Padding(14, 10, 14, 8);
            systemRecommendationLabel.TextAlign = ContentAlignment.TopLeft;

            root.Controls.Add(toolbar, 0, 0);
            root.Controls.Add(cards, 0, 1);
            root.Controls.Add(systemSummaryLabel, 0, 2);
            root.Controls.Add(systemGrid, 0, 3);
            root.Controls.Add(systemRecommendationLabel, 0, 4);
            return root;
        }

        private Control BuildLiveLogsPanel()
        {
            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 2,
                ColumnCount = 1,
                Padding = new Padding(12),
                BackColor = Color.FromArgb(10, 18, 32),
            };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            var toolbar = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                BackColor = Color.FromArgb(10, 18, 32),
            };
            toolbar.Controls.Add(Button("Refresh Live Logs", delegate { RefreshLiveLogs(); }));
            toolbar.Controls.Add(Button("Open MWL Log", delegate { OpenFirstExistingLog(MwlLogCandidates()); }));
            toolbar.Controls.Add(Button("Open DIMSE Log", delegate { OpenFirstExistingLog(DicomLogCandidates()); }));
            toolbar.Controls.Add(Button("Open Logs Folder", delegate { OpenPath(logDir); }));

            var split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Horizontal,
                SplitterDistance = 260,
                BackColor = Color.FromArgb(10, 18, 32),
            };
            split.Panel1.Controls.Add(BuildLogGroup("MWL LIVE QUERY LOG", mwlLiveLogBox, Color.FromArgb(34, 211, 238)));
            split.Panel2.Controls.Add(BuildLogGroup("DICOM TRAFFIC LIVE LOG", dicomLiveLogBox, Color.FromArgb(251, 191, 36)));
            root.Controls.Add(toolbar, 0, 0);
            root.Controls.Add(split, 0, 1);
            return root;
        }

        private Control BuildLogGroup(string title, RichTextBox box, Color accent)
        {
            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 2,
                ColumnCount = 1,
                Padding = new Padding(0, 0, 0, 10),
                BackColor = Color.FromArgb(10, 18, 32),
            };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var label = new Label
            {
                Dock = DockStyle.Fill,
                Text = title,
                ForeColor = accent,
                Font = new Font("Consolas", 10F, FontStyle.Bold),
                TextAlign = ContentAlignment.MiddleLeft,
            };
            box.Dock = DockStyle.Fill;
            box.ReadOnly = true;
            box.BackColor = Color.FromArgb(2, 6, 23);
            box.ForeColor = Color.FromArgb(226, 232, 240);
            box.BorderStyle = BorderStyle.FixedSingle;
            box.Font = new Font("Consolas", 9F);
            box.WordWrap = false;
            root.Controls.Add(label, 0, 0);
            root.Controls.Add(box, 0, 1);
            return root;
        }

        private Control BuildMetricCard(string title, Label valueLabel, Label hintLabel, Color accent, ProgressBar progress)
        {
            var panel = new Panel
            {
                Width = 258,
                Height = 144,
                Margin = new Padding(0, 0, 14, 14),
                Padding = new Padding(14),
                BackColor = Color.FromArgb(15, 23, 42),
            };

            var accentBar = new Panel
            {
                Dock = DockStyle.Left,
                Width = 4,
                BackColor = accent,
            };
            panel.Controls.Add(accentBar);

            var layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = progress == null ? 3 : 4,
                ColumnCount = 1,
                Padding = new Padding(12, 0, 0, 0),
                BackColor = Color.Transparent,
            };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            if (progress != null) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 18));

            var titleLabel = new Label
            {
                Text = title,
                Dock = DockStyle.Fill,
                Font = new Font("Segoe UI Semibold", 8.5F),
                ForeColor = accent,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            valueLabel.Text = "--";
            valueLabel.Dock = DockStyle.Fill;
            valueLabel.Font = new Font("Segoe UI Semibold", 20F);
            valueLabel.ForeColor = Color.White;
            valueLabel.TextAlign = ContentAlignment.MiddleLeft;
            valueLabel.AutoEllipsis = true;
            hintLabel.Text = "Waiting for scan";
            hintLabel.Dock = DockStyle.Fill;
            hintLabel.Font = new Font("Segoe UI", 9F);
            hintLabel.ForeColor = Color.FromArgb(203, 213, 225);
            hintLabel.TextAlign = ContentAlignment.TopLeft;
            hintLabel.AutoEllipsis = true;

            layout.Controls.Add(titleLabel, 0, 0);
            layout.Controls.Add(valueLabel, 0, 1);
            layout.Controls.Add(hintLabel, 0, 2);
            if (progress != null)
            {
                progress.Dock = DockStyle.Fill;
                progress.Minimum = 0;
                progress.Maximum = 100;
                progress.Value = 0;
                layout.Controls.Add(progress, 0, 3);
            }
            panel.Controls.Add(layout);
            return panel;
        }

        private Control BuildDicomConfigPanel()
        {
            var panel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 11,
                Padding = new Padding(18),
            };
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180));
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            for (var i = 0; i < 6; i++) panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            pacsAetText = TextInput("VEXA");
            pacsPortInput = PortInput(8889);
            mwlAetText = TextInput("VEXARIS");
            mwlPortInput = PortInput(8887);
            storageCompressionCheck = new CheckBox
            {
                Text = "Compress newly received DICOM files",
                Checked = true,
                AutoSize = true,
                Margin = new Padding(0, 10, 0, 5),
            };
            storageCompressionProfileSelect = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                Dock = DockStyle.Left,
                Width = 430,
                Margin = new Padding(0, 5, 0, 5),
            };
            storageCompressionProfileSelect.Items.Add("Level 2 - JPEG 2000 Lossless (Recommended / smaller)");
            storageCompressionProfileSelect.Items.Add("Level 1 - JPEG-LS Lossless (Faster ingest)");
            storageCompressionProfileSelect.SelectedIndex = 0;
            storageCompressionCheck.CheckedChanged += delegate
            {
                storageCompressionProfileSelect.Enabled = storageCompressionCheck.Checked;
            };
            dicomConfigStatus = new Label
            {
                Dock = DockStyle.Fill,
                ForeColor = Color.DimGray,
                TextAlign = ContentAlignment.MiddleLeft,
            };

            AddFormRow(panel, 0, "PACS DIMSE AET", pacsAetText);
            AddFormRow(panel, 1, "PACS DIMSE Port", pacsPortInput);
            AddFormRow(panel, 2, "RIS MWL AET", mwlAetText);
            AddFormRow(panel, 3, "RIS MWL Port", mwlPortInput);
            AddFormRow(panel, 4, "Storage Compression", storageCompressionCheck);
            AddFormRow(panel, 5, "Compression Level / Recipe", storageCompressionProfileSelect);

            var compressionHint = new Label
            {
                Text = "Level 0 = disabled/original, Level 1 = faster lossless ingest, Level 2 = recommended lossless storage saving. Decoded pixels remain identical. Only newly received files are affected.",
                Dock = DockStyle.Fill,
                ForeColor = Color.FromArgb(22, 101, 52),
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            panel.Controls.Add(compressionHint, 1, 6);

            var hint = new Label
            {
                Text = "Perubahan disimpan ke environment service Windows. Setelah save, service PACS DIMSE, MWL, dan RIS Backend perlu restart.",
                Dock = DockStyle.Fill,
                ForeColor = Color.DimGray,
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            panel.Controls.Add(hint, 1, 7);

            var buttons = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
            };
            buttons.Controls.Add(Button("Load Current", delegate { LoadDicomConfig(); }));
            buttons.Controls.Add(Button("Save", delegate { SaveDicomConfig(false); }));
            buttons.Controls.Add(Button("Save + Restart DICOM", delegate { SaveDicomConfig(true); }));
            buttons.Controls.Add(Button("Open Firewall Ports", delegate { OpenDicomFirewallPorts(); }));
            panel.Controls.Add(buttons, 1, 8);
            panel.Controls.Add(dicomConfigStatus, 1, 9);

            var note = new Label
            {
                Text = "Default compression: JPEG 2000 Lossless. Existing studies are never recompressed automatically. Run as Administrator so Save, Restart, and Firewall actions can update Windows services.",
                Dock = DockStyle.Fill,
                ForeColor = Color.DimGray,
                AutoSize = false,
                TextAlign = ContentAlignment.TopLeft,
            };
            panel.Controls.Add(note, 1, 10);
            return panel;
        }

        private TextBox TextInput(string value)
        {
            return new TextBox
            {
                Text = value,
                Dock = DockStyle.Fill,
                Margin = new Padding(0, 5, 0, 5),
            };
        }

        private NumericUpDown PortInput(int value)
        {
            return new NumericUpDown
            {
                Minimum = 1,
                Maximum = 65535,
                Value = value,
                Dock = DockStyle.Left,
                Width = 120,
                Margin = new Padding(0, 5, 0, 5),
            };
        }

        private void AddFormRow(TableLayoutPanel panel, int row, string labelText, Control input)
        {
            var label = new Label
            {
                Text = labelText,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            panel.Controls.Add(label, 0, row);
            panel.Controls.Add(input, 1, row);
        }

        private Button Button(string text, EventHandler onClick)
        {
            var button = new Button
            {
                Text = text,
                AutoSize = true,
                Height = 32,
                Margin = new Padding(0, 4, 8, 4),
                Padding = new Padding(10, 0, 10, 0),
                BackColor = Color.FromArgb(30, 41, 59),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
            };
            button.FlatAppearance.BorderColor = Color.FromArgb(71, 85, 105);
            button.FlatAppearance.MouseOverBackColor = Color.FromArgb(14, 116, 144);
            button.Click += onClick;
            return button;
        }

        private bool IsAdministrator()
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                var principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        private void RefreshServices()
        {
            var selected = SelectedServiceName();
            var allServices = ServiceController.GetServices()
                .ToDictionary(service => service.ServiceName, StringComparer.OrdinalIgnoreCase);

            grid.Rows.Clear();
            foreach (var definition in KnownServices)
            {
                ServiceController service;
                var installed = allServices.TryGetValue(definition.Name, out service);
                var rowIndex = grid.Rows.Add(
                    definition.Group,
                    definition.Name,
                    definition.Label,
                    installed ? service.Status.ToString() : "Missing",
                    installed ? GetStartType(definition.Name) : "-",
                    installed ? (service.CanStop ? "Yes" : "No") : "-",
                    installed ? service.DisplayName : "-"
                );
                var row = grid.Rows[rowIndex];
                row.Tag = definition.Name;
                PaintRow(row, installed ? service.Status.ToString() : "Missing");
                if (string.Equals(selected, definition.Name, StringComparison.OrdinalIgnoreCase))
                {
                    row.Selected = true;
                }
                if (installed) service.Dispose();
            }

            adminLabel.Text = IsAdministrator() ? "Administrator mode" : "Limited mode";
            adminLabel.ForeColor = IsAdministrator() ? Color.SeaGreen : Color.Firebrick;
            statusLabel.Text = string.Format("Last refresh: {0:yyyy-MM-dd HH:mm:ss} | Logs: {1}", DateTime.Now, logDir);
        }

        private void RefreshLiveLogs()
        {
            mwlLiveLogBox.Text = ReadTailFromCandidates(MwlLogCandidates(), 220);
            dicomLiveLogBox.Text = ReadTailFromCandidates(DicomLogCandidates(), 220);
            mwlLiveLogBox.SelectionStart = mwlLiveLogBox.TextLength;
            mwlLiveLogBox.ScrollToCaret();
            dicomLiveLogBox.SelectionStart = dicomLiveLogBox.TextLength;
            dicomLiveLogBox.ScrollToCaret();
            statusLabel.Text = string.Format("Live logs refreshed: {0:yyyy-MM-dd HH:mm:ss}", DateTime.Now);
        }

        private string[] MwlLogCandidates()
        {
            return new[]
            {
                Path.Combine(logDir, "VexaMwlService.out.log"),
                Path.Combine(logDir, "VexaMwlService.err.log"),
                Path.Combine(logDir, "mwl-scp.log"),
                Path.Combine(logDir, "VexaRISBackend.out.log"),
            };
        }

        private string[] DicomLogCandidates()
        {
            return new[]
            {
                Path.Combine(logDir, "VexaPacsDimse.out.log"),
                Path.Combine(logDir, "VexaPacsDimse.err.log"),
                Path.Combine(logDir, "front-scp.log"),
                Path.Combine(logDir, "VexaPacsDicomweb.out.log"),
                Path.Combine(logDir, "VexaPacsDicomweb.err.log"),
            };
        }

        private string ReadTailFromCandidates(string[] candidates, int maxLines)
        {
            var builder = new StringBuilder();
            foreach (var path in candidates)
            {
                if (!File.Exists(path)) continue;
                builder.AppendLine("===== " + path + " =====");
                builder.AppendLine(ReadTail(path, maxLines / Math.Max(1, candidates.Length)));
                builder.AppendLine();
            }
            return builder.Length > 0 ? builder.ToString() : "No log file found yet.";
        }

        private string ReadTail(string path, int maxLines)
        {
            try
            {
                const int maxBytes = 1024 * 1024;
                string text;
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (stream.Length > maxBytes)
                    {
                        stream.Seek(-maxBytes, SeekOrigin.End);
                    }
                    using (var reader = new StreamReader(stream, Encoding.UTF8, true))
                    {
                        text = reader.ReadToEnd();
                    }
                }
                var lines = text
                    .Replace("\r\n", "\n")
                    .Replace('\r', '\n')
                    .Split(new[] { '\n' }, StringSplitOptions.None);
                return string.Join(Environment.NewLine, lines.Skip(Math.Max(0, lines.Length - Math.Max(20, maxLines))));
            }
            catch (Exception error)
            {
                return "Unable to read " + path + ": " + error.Message;
            }
        }

        private void OpenFirstExistingLog(string[] candidates)
        {
            var path = candidates.FirstOrDefault(File.Exists);
            if (string.IsNullOrWhiteSpace(path))
            {
                MessageBox.Show(this, "No matching log file exists yet.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            OpenPath(path);
        }

        private void RefreshSystemMonitor()
        {
            SetBusy(true, "Refreshing system monitor...");
            try
            {
                var config = LoadBackupConfig();
                currentDataPath = FirstNonEmpty(
                    GetConfigValue(config, "dataPath"),
                    GetEnvValue(ReadServiceEnvironment("VexaRISBackend"), "DICOM_STORAGE_PATH"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "VEXAPACS", "DATA")
                );
                currentBackupRoot = FirstNonEmpty(
                    GetConfigValue(config, "backupRoot"),
                    Path.Combine(Path.GetPathRoot(currentDataPath) ?? "C:\\", "VEXAPACS-Backup")
                );

                var postgres = BuildPostgresConfig(config);
                var drive = GetDriveInfoForPath(currentDataPath);
                var dataSize = GetDirectorySizeSafe(currentDataPath);
                var backupSize = GetDirectorySizeSafe(currentBackupRoot);
                var lastBackup = GetLatestBackup(currentBackupRoot);
                var risDbSize = QueryDatabaseSize(postgres, postgres.RisDb);
                var pacsDbSize = QueryDatabaseSize(postgres, postgres.PacsDb);
                var studyCount = QueryLong(postgres, postgres.PacsDb, "SELECT COUNT(*) FROM pacs_studies;");
                var instanceCount = QueryLong(postgres, postgres.PacsDb, "SELECT COUNT(*) FROM pacs_instances;");
                var recentStudies = QueryLong(postgres, postgres.PacsDb, "SELECT COUNT(*) FROM pacs_studies WHERE created_at >= NOW() - INTERVAL '30 days';");

                UpdateSystemCards(drive, dataSize, backupSize, risDbSize, pacsDbSize, studyCount, instanceCount, recentStudies);

                systemGrid.Rows.Clear();
                lastSystemMetrics.Clear();
                AddMetric("DATA path", currentDataPath, Directory.Exists(currentDataPath) ? "OK" : "Folder not found");
                AddMetric("DATA used", FormatBytes(dataSize), "DICOM files in DATA folder");
                AddMetric("Backup root", currentBackupRoot, Directory.Exists(currentBackupRoot) ? "OK" : "Folder not found");
                AddMetric("Backup used", FormatBytes(backupSize), "Total backup folder usage");
                AddMetric("Latest backup", lastBackup.Label, lastBackup.Notes);

                if (drive != null)
                {
                    AddMetric("Storage total", FormatBytes(drive.TotalSize), drive.Name);
                    AddMetric("Storage used", FormatBytes(drive.TotalSize - drive.AvailableFreeSpace), FormatPercent(drive.TotalSize - drive.AvailableFreeSpace, drive.TotalSize));
                    AddMetric("Storage free", FormatBytes(drive.AvailableFreeSpace), FormatPercent(drive.AvailableFreeSpace, drive.TotalSize) + " free");
                }
                else
                {
                    AddMetric("Storage", "Unavailable", "Unable to resolve drive from DATA path");
                }

                AddMetric("RIS DB size", FormatOptionalBytes(risDbSize), postgres.RisDb);
                AddMetric("PACS DB size", FormatOptionalBytes(pacsDbSize), postgres.PacsDb);
                AddMetric("Total studies", FormatOptionalNumber(studyCount), "pacs_studies");
                AddMetric("Total instances", FormatOptionalNumber(instanceCount), "pacs_instances");
                AddMetric("Last 30 days studies", FormatOptionalNumber(recentStudies), "Used for storage endurance estimate");

                var estimate = BuildStorageEstimate(drive, dataSize, studyCount, recentStudies);
                lastStorageEstimate = estimate;
                lastSystemRefreshAt = DateTime.Now;
                systemSummaryLabel.Text = estimate.Summary;
                systemRecommendationLabel.Text = estimate.Recommendation;
                statusLabel.Text = string.Format("System monitor refreshed: {0:yyyy-MM-dd HH:mm:ss}", DateTime.Now);
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, "System monitor failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
                statusLabel.Text = "System monitor failed: " + error.Message;
            }
            finally
            {
                SetBusy(false, null);
            }
        }

        private void AddMetric(string metric, string value, string notes)
        {
            lastSystemMetrics.Add(new MetricRow(metric, value, notes));
            var rowIndex = systemGrid.Rows.Add(metric, value, notes);
            var row = systemGrid.Rows[rowIndex];
            if (metric.IndexOf("free", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                row.DefaultCellStyle.BackColor = Color.FromArgb(22, 78, 99);
            }
            else if (metric.IndexOf("backup", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                row.DefaultCellStyle.BackColor = Color.FromArgb(30, 27, 75);
            }
            else if (metric.IndexOf("DB", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                row.DefaultCellStyle.BackColor = Color.FromArgb(20, 83, 45);
            }
            else
            {
                row.DefaultCellStyle.BackColor = Color.FromArgb(15, 23, 42);
            }
            row.DefaultCellStyle.ForeColor = Color.FromArgb(226, 232, 240);
        }

        private void UpdateSystemCards(
            DriveInfo drive,
            long dataSize,
            long backupSize,
            long? risDbSize,
            long? pacsDbSize,
            long? studyCount,
            long? instanceCount,
            long? recentStudies)
        {
            if (drive != null)
            {
                var used = drive.TotalSize - drive.AvailableFreeSpace;
                var percent = drive.TotalSize <= 0 ? 0 : (int)Math.Max(0, Math.Min(100, Math.Round(used * 100D / drive.TotalSize)));
                storageProgress.Value = percent;
                storageCardValue.Text = FormatBytes(drive.AvailableFreeSpace);
                storageCardHint.Text = string.Format("{0} free | {1} used from {2}", FormatPercent(drive.AvailableFreeSpace, drive.TotalSize), FormatBytes(used), FormatBytes(drive.TotalSize));
            }
            else
            {
                storageProgress.Value = 0;
                storageCardValue.Text = "N/A";
                storageCardHint.Text = "DATA drive cannot be resolved";
            }

            backupCardValue.Text = FormatBytes(backupSize);
            backupCardHint.Text = string.Format("Backup root usage | DATA {0}", FormatBytes(dataSize));

            var totalDb = risDbSize.GetValueOrDefault() + pacsDbSize.GetValueOrDefault();
            databaseCardValue.Text = (risDbSize.HasValue || pacsDbSize.HasValue) ? FormatBytes(totalDb) : "N/A";
            databaseCardHint.Text = string.Format("RIS {0} | PACS {1}", FormatOptionalBytes(risDbSize), FormatOptionalBytes(pacsDbSize));

            studyCardValue.Text = FormatOptionalNumber(studyCount);
            studyCardHint.Text = string.Format("{0} instances | {1} studies in 30 days", FormatOptionalNumber(instanceCount), FormatOptionalNumber(recentStudies));
        }

        private void ExportSystemReport()
        {
            try
            {
                if (lastSystemMetrics.Count == 0)
                {
                    RefreshSystemMonitor();
                }
                using (var hospitalDialog = new HospitalNameForm())
                {
                    if (hospitalDialog.ShowDialog(this) != DialogResult.OK) return;
                    using (var save = new SaveFileDialog())
                    {
                        save.Filter = "PDF report (*.pdf)|*.pdf";
                        save.FileName = "VEXA-System-Report-" + DateTime.Now.ToString("yyyyMMdd-HHmm") + ".pdf";
                        save.Title = "Export VEXA SYSTEM Report";
                        if (save.ShowDialog(this) != DialogResult.OK) return;

                        var logoPath = FindLogoPath();
                        PdfReportWriter.Write(
                            save.FileName,
                            logoPath,
                            hospitalDialog.HospitalName,
                            lastSystemRefreshAt == DateTime.MinValue ? DateTime.Now : lastSystemRefreshAt,
                            storageCardValue.Text,
                            storageCardHint.Text,
                            backupCardValue.Text,
                            backupCardHint.Text,
                            databaseCardValue.Text,
                            databaseCardHint.Text,
                            studyCardValue.Text,
                            studyCardHint.Text,
                            lastStorageEstimate == null ? systemSummaryLabel.Text : lastStorageEstimate.Summary,
                            lastStorageEstimate == null ? systemRecommendationLabel.Text : lastStorageEstimate.Recommendation,
                            lastSystemMetrics.ToArray()
                        );
                        MessageBox.Show(this, "PDF report exported:\r\n" + save.FileName, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                        OpenPath(save.FileName);
                    }
                }
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, "Export PDF failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private Dictionary<string, string> LoadBackupConfig()
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "VEXAPACS",
                "backup.config.json"
            );
            if (!File.Exists(path)) return result;
            var text = File.ReadAllText(path);
            foreach (Match match in Regex.Matches(text, "\"(?<key>[A-Za-z0-9_]+)\"\\s*:\\s*\"(?<value>(?:\\\\.|[^\"])*)\""))
            {
                result[match.Groups["key"].Value] = UnescapeJson(match.Groups["value"].Value);
            }
            return result;
        }

        private string GetConfigValue(Dictionary<string, string> config, string key)
        {
            string value;
            return config.TryGetValue(key, out value) ? value : null;
        }

        private PostgresConfig BuildPostgresConfig(Dictionary<string, string> backupConfig)
        {
            var risEnv = ReadServiceEnvironment("VexaRISBackend");
            var config = new PostgresConfig();
            config.BinPath = FirstNonEmpty(GetConfigValue(backupConfig, "binPath"), FindPostgresBinPath());
            config.Host = FirstNonEmpty(GetConfigValue(backupConfig, "host"), GetEnvValue(risEnv, "DB_HOST"), "127.0.0.1");
            config.Port = FirstNonEmpty(GetConfigValue(backupConfig, "port"), GetEnvValue(risEnv, "DB_PORT"), "5432");
            config.User = FirstNonEmpty(GetConfigValue(backupConfig, "user"), GetEnvValue(risEnv, "DB_USER"), "postgres");
            config.Password = FirstNonEmpty(GetConfigValue(backupConfig, "password"), GetEnvValue(risEnv, "DB_PASS"));
            config.RisDb = FirstNonEmpty(GetConfigValue(backupConfig, "risDb"), GetEnvValue(risEnv, "DB_NAME"), "veloris_db");
            config.PacsDb = FirstNonEmpty(GetConfigValue(backupConfig, "pacsDb"), GetEnvValue(risEnv, "PACS_DB_NAME"), "velopacs_db");
            return config;
        }

        private string FindPostgresBinPath()
        {
            var fromPath = FindExecutableInPath("psql.exe");
            if (!string.IsNullOrWhiteSpace(fromPath)) return Path.GetDirectoryName(fromPath);
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PostgreSQL");
            if (!Directory.Exists(root)) return string.Empty;
            try
            {
                var found = Directory.GetFiles(root, "psql.exe", SearchOption.AllDirectories)
                    .OrderByDescending(path => path)
                    .FirstOrDefault();
                return string.IsNullOrWhiteSpace(found) ? string.Empty : Path.GetDirectoryName(found);
            }
            catch
            {
                return string.Empty;
            }
        }

        private string FindExecutableInPath(string executable)
        {
            var pathValue = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (var path in pathValue.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(path)) continue;
                var candidate = Path.Combine(path.Trim(), executable);
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        private long? QueryDatabaseSize(PostgresConfig config, string database)
        {
            return QueryLong(config, "postgres", "SELECT pg_database_size('" + EscapeSqlLiteral(database) + "');");
        }

        private long? QueryLong(PostgresConfig config, string database, string sql)
        {
            try
            {
                var value = RunPsqlScalar(config, database, sql);
                long parsed;
                return long.TryParse((value ?? string.Empty).Trim(), out parsed) ? (long?)parsed : null;
            }
            catch
            {
                return null;
            }
        }

        private string RunPsqlScalar(PostgresConfig config, string database, string sql)
        {
            var psql = ResolvePsql(config);
            if (string.IsNullOrWhiteSpace(psql)) throw new InvalidOperationException("psql.exe was not found.");
            var start = new ProcessStartInfo
            {
                FileName = psql,
                Arguments = "-h " + Quote(config.Host) + " -p " + Quote(config.Port) + " -U " + Quote(config.User) + " -d " + Quote(database) + " -tAc " + Quote(sql),
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            if (!string.IsNullOrEmpty(config.Password))
            {
                start.EnvironmentVariables["PGPASSWORD"] = config.Password;
            }
            using (var process = Process.Start(start))
            {
                var output = process.StandardOutput.ReadToEnd();
                var error = process.StandardError.ReadToEnd();
                process.WaitForExit(8000);
                if (process.ExitCode != 0) throw new InvalidOperationException(error.Length > 0 ? error : output);
                return output.Trim();
            }
        }

        private string ResolvePsql(PostgresConfig config)
        {
            if (!string.IsNullOrWhiteSpace(config.BinPath))
            {
                var candidate = Path.Combine(config.BinPath, "psql.exe");
                if (File.Exists(candidate)) return candidate;
            }
            return FindExecutableInPath("psql.exe");
        }

        private DriveInfo GetDriveInfoForPath(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path)) return null;
                var root = Path.GetPathRoot(Path.GetFullPath(path));
                return string.IsNullOrWhiteSpace(root) ? null : new DriveInfo(root);
            }
            catch
            {
                return null;
            }
        }

        private long GetDirectorySizeSafe(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return 0;
                return Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories)
                    .Sum(file =>
                    {
                        try { return new FileInfo(file).Length; }
                        catch { return 0L; }
                    });
            }
            catch
            {
                return 0;
            }
        }

        private BackupInfo GetLatestBackup(string backupRoot)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(backupRoot) || !Directory.Exists(backupRoot))
                {
                    return new BackupInfo { Label = "Unavailable", Notes = "Backup root not found" };
                }
                var latest = new DirectoryInfo(backupRoot)
                    .GetDirectories()
                    .OrderByDescending(item => item.CreationTimeUtc)
                    .FirstOrDefault();
                if (latest == null) return new BackupInfo { Label = "None", Notes = "No backup folders found" };
                return new BackupInfo
                {
                    Label = latest.Name + " (" + FormatBytes(GetDirectorySizeSafe(latest.FullName)) + ")",
                    Notes = latest.FullName,
                };
            }
            catch (Exception error)
            {
                return new BackupInfo { Label = "Unavailable", Notes = error.Message };
            }
        }

        private StorageEstimate BuildStorageEstimate(DriveInfo drive, long dataSize, long? studyCount, long? recentStudies)
        {
            if (drive == null)
            {
                return new StorageEstimate
                {
                    Summary = "Storage summary unavailable because DATA drive cannot be resolved.",
                    Recommendation = "Recommendation: check DATA path first, then refresh this page.",
                };
            }

            var free = drive.AvailableFreeSpace;
            var avgStudySize = studyCount.HasValue && studyCount.Value > 0 ? dataSize / (double)studyCount.Value : 0D;
            var studiesPerDay = recentStudies.HasValue && recentStudies.Value > 0 ? recentStudies.Value / 30D : 0D;
            var dailyGrowth = avgStudySize * studiesPerDay;

            if (avgStudySize <= 0 || dailyGrowth <= 0)
            {
                return new StorageEstimate
                {
                    Summary = string.Format("Storage free: {0} of {1}. Study growth estimate needs more PACS data.", FormatBytes(free), FormatBytes(drive.TotalSize)),
                    Recommendation = "Recommendation: keep at least 30 percent free storage. After the site has 30 days of real studies, refresh to get endurance and capacity planning.",
                };
            }

            var daysRemaining = free / dailyGrowth;
            var targetDays = 365D;
            var targetBytes = Math.Max(0D, (dailyGrowth * targetDays * 1.2D) - free);
            var when = DateTime.Today.AddDays(Math.Max(0D, daysRemaining));
            var recommendation = daysRemaining < 180D
                ? string.Format("Recommendation: add about {0} storage now to keep roughly 12 months runway with 20% buffer. Estimated low-storage date: {1:yyyy-MM-dd}.", FormatBytes((long)targetBytes), when)
                : string.Format("Recommendation: current runway is healthy. Review storage again around {0:yyyy-MM-dd}, or when free storage drops below 30%.", DateTime.Today.AddDays(Math.Max(30D, daysRemaining - 90D)));

            return new StorageEstimate
            {
                Summary = string.Format(
                    "Average study size: {0}. Growth: {1}/day from {2} studies in the last 30 days. Estimated runway: {3:0} days.",
                    FormatBytes((long)avgStudySize),
                    FormatBytes((long)dailyGrowth),
                    recentStudies.GetValueOrDefault(),
                    daysRemaining
                ),
                Recommendation = recommendation,
            };
        }

        private void PaintRow(DataGridViewRow row, string status)
        {
            var color = Color.White;
            if (string.Equals(status, "Running", StringComparison.OrdinalIgnoreCase)) color = Color.FromArgb(222, 245, 229);
            else if (string.Equals(status, "Stopped", StringComparison.OrdinalIgnoreCase)) color = Color.FromArgb(253, 232, 232);
            else if (string.Equals(status, "Paused", StringComparison.OrdinalIgnoreCase)) color = Color.FromArgb(255, 247, 213);
            else if (string.Equals(status, "Missing", StringComparison.OrdinalIgnoreCase)) color = Color.FromArgb(238, 238, 238);
            else color = Color.FromArgb(232, 241, 255);
            row.DefaultCellStyle.BackColor = color;
        }

        private string GetStartType(string serviceName)
        {
            try
            {
                var query = new ProcessStartInfo
                {
                    FileName = "sc.exe",
                    Arguments = "qc " + Quote(serviceName),
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                };
                using (var process = Process.Start(query))
                {
                    var output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit(3000);
                    var line = output.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None)
                        .FirstOrDefault(item => item.IndexOf("START_TYPE", StringComparison.OrdinalIgnoreCase) >= 0);
                    if (line == null) return "-";
                    if (line.IndexOf("AUTO_START", StringComparison.OrdinalIgnoreCase) >= 0) return "Automatic";
                    if (line.IndexOf("DEMAND_START", StringComparison.OrdinalIgnoreCase) >= 0) return "Manual";
                    if (line.IndexOf("DISABLED", StringComparison.OrdinalIgnoreCase) >= 0) return "Disabled";
                    return line.Trim();
                }
            }
            catch
            {
                return "-";
            }
        }

        private string SelectedServiceName()
        {
            if (grid.SelectedRows.Count == 0) return null;
            return grid.SelectedRows[0].Tag as string;
        }

        private async Task ServiceAction(string action)
        {
            var serviceName = SelectedServiceName();
            if (string.IsNullOrWhiteSpace(serviceName))
            {
                MessageBox.Show(this, "Select a service first.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            await RunServiceAction(serviceName, action);
        }

        private async Task RestartAll()
        {
            var confirm = MessageBox.Show(
                this,
                "Restart all installed VEXA services?",
                Text,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (confirm != DialogResult.Yes) return;

            foreach (var service in KnownServices)
            {
                await RunServiceAction(service.Name, "restart", false);
            }
            RefreshServices();
        }

        private async Task RunServiceAction(string serviceName, string action, bool refreshAfter = true)
        {
            SetBusy(true, string.Format("{0} {1}...", action, serviceName));
            try
            {
                await Task.Run(delegate
                {
                    using (var service = new ServiceController(serviceName))
                    {
                        if (action == "start")
                        {
                            StartService(service);
                        }
                        else if (action == "stop")
                        {
                            StopService(service);
                        }
                        else if (action == "restart")
                        {
                            StopService(service);
                            service.Refresh();
                            StartService(service);
                        }
                    }
                });
                statusLabel.Text = string.Format("{0} {1} completed.", action, serviceName);
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, "Service action failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
                statusLabel.Text = string.Format("{0} {1} failed: {2}", action, serviceName, error.Message);
            }
            finally
            {
                SetBusy(false, null);
                if (refreshAfter) RefreshServices();
            }
        }

        private void LoadDicomConfig()
        {
            try
            {
                var pacsDimse = ReadServiceEnvironment("VexaPacsDimse");
                var pacsDicomweb = ReadServiceEnvironment("VexaPacsDicomweb");
                var mwl = ReadServiceEnvironment("VexaMwlService");
                var ris = ReadServiceEnvironment("VexaRISBackend");

                pacsAetText.Text = FirstNonEmpty(
                    GetEnvValue(pacsDimse, "DICOMWEB_EXTERNAL_AET"),
                    GetEnvValue(ris, "DICOMWEB_PACS_AET"),
                    "VEXA"
                );
                pacsPortInput.Value = ToPort(
                    FirstNonEmpty(
                        GetEnvValue(pacsDimse, "DICOMWEB_EXTERNAL_PORT"),
                        GetEnvValue(ris, "DICOMWEB_PACS_DICOM_PORT"),
                        "8889"
                    ),
                    8889
                );
                mwlAetText.Text = FirstNonEmpty(
                    GetEnvValue(mwl, "MWL_SCP_AET"),
                    GetEnvValue(ris, "MWL_SCP_AET"),
                    "VEXARIS"
                );
                mwlPortInput.Value = ToPort(
                    FirstNonEmpty(
                        GetEnvValue(mwl, "MWL_SCP_PORT"),
                        GetEnvValue(ris, "MWL_SCP_PORT"),
                        "8887"
                    ),
                    8887
                );

                var storageCompressionEnabled = ToBoolean(
                    FirstNonEmpty(
                        GetEnvValue(pacsDicomweb, "DICOMWEB_DIMSE_STORAGE_COMPRESSION"),
                        GetEnvValue(pacsDimse, "DICOMWEB_DIMSE_STORAGE_COMPRESSION"),
                        "true"
                    ),
                    true
                );
                var storageTransferSyntax = FirstNonEmpty(
                    GetEnvValue(pacsDicomweb, "DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX"),
                    GetEnvValue(pacsDimse, "DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX"),
                    Jpeg2000LosslessUid
                );
                storageCompressionCheck.Checked = storageCompressionEnabled;
                storageCompressionProfileSelect.SelectedIndex = storageTransferSyntax == JpegLsLosslessUid ? 1 : 0;
                storageCompressionProfileSelect.Enabled = storageCompressionEnabled;

                dicomConfigStatus.Text = "Current DICOM config loaded. Storage: " + StorageCompressionSummary();
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, "Failed to load DICOM config", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void SaveDicomConfig(bool restart)
        {
            try
            {
                var pacsAet = NormalizeAet(pacsAetText.Text, "PACS DIMSE AET");
                var mwlAet = NormalizeAet(mwlAetText.Text, "RIS MWL AET");
                var pacsPort = Convert.ToInt32(pacsPortInput.Value);
                var mwlPort = Convert.ToInt32(mwlPortInput.Value);
                var storageCompressionEnabled = storageCompressionCheck.Checked;
                var storageTransferSyntax = SelectedStorageTransferSyntax();
                var internalPort = pacsPort == 65535 ? 65534 : pacsPort + 1;
                var internalAet = (pacsAet.Length > 12 ? pacsAet.Substring(0, 12) : pacsAet) + "_INT";

                UpsertServiceEnvironment("VexaPacsDimse", new Dictionary<string, string>
                {
                    { "DICOMWEB_EXTERNAL_AET", pacsAet },
                    { "DICOMWEB_EXTERNAL_HOST", "0.0.0.0" },
                    { "DICOMWEB_EXTERNAL_PORT", pacsPort.ToString() },
                    { "DICOMWEB_INTERNAL_AET", internalAet },
                    { "DICOMWEB_INTERNAL_HOST", "127.0.0.1" },
                    { "DICOMWEB_INTERNAL_PORT", internalPort.ToString() },
                    { "DICOMWEB_DIMSE_STORAGE_COMPRESSION", storageCompressionEnabled ? "true" : "false" },
                    { "DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX", storageTransferSyntax },
                });

                UpsertServiceEnvironment("VexaPacsDicomweb", new Dictionary<string, string>
                {
                    { "DICOMWEB_DIMSE_STORAGE_COMPRESSION", storageCompressionEnabled ? "true" : "false" },
                    { "DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX", storageTransferSyntax },
                });

                UpsertServiceEnvironment("VexaMwlService", new Dictionary<string, string>
                {
                    { "MWL_SCP_AET", mwlAet },
                    { "MWL_SCP_BIND", "0.0.0.0" },
                    { "MWL_SCP_PORT", mwlPort.ToString() },
                });

                UpsertServiceEnvironment("VexaRISBackend", new Dictionary<string, string>
                {
                    { "DICOMWEB_PACS_AET", pacsAet },
                    { "DICOMWEB_PACS_DICOM_HOST", "127.0.0.1" },
                    { "DICOMWEB_PACS_DICOM_PORT", pacsPort.ToString() },
                    { "MWL_SCP_AET", mwlAet },
                    { "MWL_SCP_BIND", "0.0.0.0" },
                    { "MWL_SCP_PORT", mwlPort.ToString() },
                });

                UpdatePacsDefaultJson(pacsAet, internalPort, storageCompressionEnabled, storageTransferSyntax);

                dicomConfigStatus.Text = string.Format(
                    "Saved: PACS {0}:{1}, MWL {2}:{3}, Storage {4}",
                    pacsAet,
                    pacsPort,
                    mwlAet,
                    mwlPort,
                    StorageCompressionSummary()
                );

                if (restart)
                {
                    RestartDicomServices();
                }
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, "Failed to save DICOM config", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async void RestartDicomServices()
        {
            await RunServiceAction("VexaPacsDicomweb", "restart", false);
            await RunServiceAction("VexaPacsDimse", "restart", false);
            await RunServiceAction("VexaMwlService", "restart", false);
            await RunServiceAction("VexaRISBackend", "restart", false);
            RefreshServices();
            dicomConfigStatus.Text += " | DICOM services restarted.";
        }

        private void OpenDicomFirewallPorts()
        {
            try
            {
                var pacsPort = Convert.ToInt32(pacsPortInput.Value);
                var mwlPort = Convert.ToInt32(mwlPortInput.Value);
                RunNetsh("advfirewall firewall add rule name=\"VEXA PACS DIMSE\" dir=in action=allow protocol=TCP localport=" + pacsPort);
                RunNetsh("advfirewall firewall add rule name=\"VEXA RIS MWL\" dir=in action=allow protocol=TCP localport=" + mwlPort);
                dicomConfigStatus.Text = string.Format("Firewall rules ensured for PACS {0} and MWL {1}.", pacsPort, mwlPort);
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, "Failed to update firewall", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void RunNetsh(string arguments)
        {
            var start = new ProcessStartInfo
            {
                FileName = "netsh.exe",
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using (var process = Process.Start(start))
            {
                var output = process.StandardOutput.ReadToEnd();
                var error = process.StandardError.ReadToEnd();
                process.WaitForExit(10000);
                if (process.ExitCode != 0)
                {
                    throw new InvalidOperationException(error.Length > 0 ? error : output);
                }
            }
        }

        private Dictionary<string, string> ReadServiceEnvironment(string serviceName)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var path = @"SYSTEM\CurrentControlSet\Services\" + serviceName + @"\Parameters";
            using (var key = Registry.LocalMachine.OpenSubKey(path, false))
            {
                if (key == null) return result;
                var raw = key.GetValue("AppEnvironmentExtra");
                var values = raw as string[];
                if (values == null && raw is string) values = new[] { (string)raw };
                if (values == null) return result;
                foreach (var item in values)
                {
                    var index = item.IndexOf('=');
                    if (index <= 0) continue;
                    result[item.Substring(0, index)] = item.Substring(index + 1);
                }
            }
            return result;
        }

        private void UpsertServiceEnvironment(string serviceName, Dictionary<string, string> updates)
        {
            var path = @"SYSTEM\CurrentControlSet\Services\" + serviceName + @"\Parameters";
            using (var key = Registry.LocalMachine.CreateSubKey(path))
            {
                if (key == null) throw new InvalidOperationException("Unable to open service registry: " + serviceName);
                var map = ReadServiceEnvironment(serviceName);
                foreach (var update in updates)
                {
                    map[update.Key] = update.Value;
                }
                var values = map
                    .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                    .Select(pair => pair.Key + "=" + pair.Value)
                    .ToArray();
                key.SetValue("AppEnvironmentExtra", values, RegistryValueKind.MultiString);
            }
        }

        private string GetEnvValue(Dictionary<string, string> values, string key)
        {
            string value;
            return values.TryGetValue(key, out value) ? value : null;
        }

        private string FirstNonEmpty(params string[] values)
        {
            foreach (var value in values)
            {
                if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
            }
            return string.Empty;
        }

        private decimal ToPort(string value, int fallback)
        {
            int port;
            if (!int.TryParse(value, out port)) port = fallback;
            if (port < 1) port = 1;
            if (port > 65535) port = 65535;
            return port;
        }

        private bool ToBoolean(string value, bool fallback)
        {
            if (string.IsNullOrWhiteSpace(value)) return fallback;
            var normalized = value.Trim().ToLowerInvariant();
            if (new[] { "1", "true", "yes", "on" }.Contains(normalized)) return true;
            if (new[] { "0", "false", "no", "off" }.Contains(normalized)) return false;
            return fallback;
        }

        private string SelectedStorageTransferSyntax()
        {
            return storageCompressionProfileSelect.SelectedIndex == 1 ? JpegLsLosslessUid : Jpeg2000LosslessUid;
        }

        private string StorageCompressionSummary()
        {
            if (!storageCompressionCheck.Checked) return "Level 0 - Original / disabled";
            return storageCompressionProfileSelect.SelectedIndex == 1
                ? "Level 1 - JPEG-LS Lossless"
                : "Level 2 - JPEG 2000 Lossless";
        }

        private string NormalizeAet(string value, string label)
        {
            var normalized = (value ?? string.Empty).Trim().ToUpperInvariant();
            if (normalized.Length == 0) throw new InvalidOperationException(label + " is required.");
            if (normalized.Length > 16) throw new InvalidOperationException(label + " max length is 16 characters.");
            if (normalized.Any(char.IsWhiteSpace)) throw new InvalidOperationException(label + " cannot contain spaces.");
            return normalized;
        }

        private void UpdatePacsDefaultJson(string pacsAet, int internalPort, bool storageCompressionEnabled, string storageTransferSyntax)
        {
            var installDir = FindInstallDir();
            if (string.IsNullOrWhiteSpace(installDir)) return;
            var configPath = Path.Combine(installDir, "PACS", "config", "default.json");
            if (!File.Exists(configPath)) return;

            var text = File.ReadAllText(configPath);
            text = ReplaceJsonString(text, "aet", (pacsAet.Length > 12 ? pacsAet.Substring(0, 12) : pacsAet) + "_INT");
            text = ReplaceJsonString(text, "ip", "127.0.0.1");
            text = ReplaceJsonString(text, "port", internalPort.ToString());
            text = ReplaceJsonBoolean(text, "dimseStorageCompression", storageCompressionEnabled);
            text = ReplaceJsonString(text, "dimseStorageTransferSyntax", storageTransferSyntax);
            File.WriteAllText(configPath, text);
        }

        private string FindInstallDir()
        {
            var candidates = new List<string>();
            var cursor = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            for (var depth = 0; cursor != null && depth < 6; depth++, cursor = cursor.Parent)
            {
                candidates.Add(cursor.FullName);
            }
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "VEXAPACS-RIS"));
            return candidates.FirstOrDefault(path =>
                !string.IsNullOrWhiteSpace(path) &&
                Directory.Exists(path) &&
                (Directory.Exists(Path.Combine(path, "RIS")) || Directory.Exists(Path.Combine(path, "PACS")))
            );
        }

        private string ReplaceJsonString(string json, string key, string value)
        {
            var pattern = "\"" + key + "\"";
            var index = json.IndexOf(pattern, StringComparison.OrdinalIgnoreCase);
            if (index < 0) return json;
            var colon = json.IndexOf(':', index + pattern.Length);
            if (colon < 0) return json;
            var firstQuote = json.IndexOf('"', colon + 1);
            if (firstQuote < 0) return json;
            var secondQuote = json.IndexOf('"', firstQuote + 1);
            if (secondQuote < 0) return json;
            return json.Substring(0, firstQuote + 1) + EscapeJson(value) + json.Substring(secondQuote);
        }

        private string ReplaceJsonBoolean(string json, string key, bool value)
        {
            var pattern = "\"" + key + "\"";
            var index = json.IndexOf(pattern, StringComparison.OrdinalIgnoreCase);
            if (index < 0) return json;
            var colon = json.IndexOf(':', index + pattern.Length);
            if (colon < 0) return json;
            var start = colon + 1;
            while (start < json.Length && char.IsWhiteSpace(json[start])) start++;
            var end = start;
            while (end < json.Length && char.IsLetter(json[end])) end++;
            if (end == start) return json;
            return json.Substring(0, start) + (value ? "true" : "false") + json.Substring(end);
        }

        private string EscapeJson(string value)
        {
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static void StartService(ServiceController service)
        {
            service.Refresh();
            if (service.Status == ServiceControllerStatus.Running) return;
            if (service.Status == ServiceControllerStatus.StartPending)
            {
                service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(45));
                return;
            }
            service.Start();
            service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(45));
        }

        private static void StopService(ServiceController service)
        {
            service.Refresh();
            if (service.Status == ServiceControllerStatus.Stopped) return;
            if (!service.CanStop && service.Status == ServiceControllerStatus.Running)
            {
                throw new InvalidOperationException(service.ServiceName + " cannot be stopped by Windows right now.");
            }
            if (service.Status == ServiceControllerStatus.StopPending)
            {
                service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(45));
                return;
            }
            service.Stop();
            service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(45));
        }

        private void SetBusy(bool busy, string message)
        {
            foreach (Control control in Controls)
            {
                control.Enabled = !busy;
            }
            UseWaitCursor = busy;
            if (!string.IsNullOrEmpty(message)) statusLabel.Text = message;
            Application.DoEvents();
        }

        private void OpenSelectedLog(string suffix)
        {
            var serviceName = SelectedServiceName();
            if (string.IsNullOrWhiteSpace(serviceName))
            {
                MessageBox.Show(this, "Select a service first.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var path = Path.Combine(logDir, serviceName + suffix);
            if (!File.Exists(path))
            {
                MessageBox.Show(this, "Log file does not exist:\r\n" + path, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            OpenPath(path);
        }

        private void OpenPath(string path)
        {
            try
            {
                if (!Directory.Exists(path) && !File.Exists(path))
                {
                    Directory.CreateDirectory(path);
                }
                Process.Start(new ProcessStartInfo
                {
                    FileName = path,
                    UseShellExecute = true,
                });
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OpenPathOrInfo(string path, string message)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            OpenPath(path);
        }

        private void RelaunchElevated()
        {
            if (IsAdministrator())
            {
                MessageBox.Show(this, "Already running as Administrator.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = Application.ExecutablePath,
                    UseShellExecute = true,
                    Verb = "runas",
                });
                Close();
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void TryApplyLogo()
        {
            try
            {
                var logoPath = FindLogoPath();
                if (string.IsNullOrWhiteSpace(logoPath)) 
                {
                    Icon = SystemIcons.Application;
                    return;
                }
                using (var bitmap = new Bitmap(logoPath))
                {
                    var handle = bitmap.GetHicon();
                    Icon = Icon.FromHandle(handle);
                }
            }
            catch
            {
                Icon = SystemIcons.Application;
            }
        }

        private string FindLogoPath()
        {
            var installDir = FindInstallDir();
            var candidates = new[]
            {
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logo.png"),
                string.IsNullOrWhiteSpace(installDir) ? null : Path.Combine(installDir, "tools", "service-monitor", "logo.png"),
                string.IsNullOrWhiteSpace(installDir) ? null : Path.Combine(installDir, "RIS", "frontend", "public", "logo.png"),
                @"D:\VELOPACS-RIS\RIS\frontend\public\logo.png",
            };
            return candidates.FirstOrDefault(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path));
        }

        private string FormatBytes(long bytes)
        {
            if (bytes < 0) bytes = 0;
            string[] units = { "B", "KB", "MB", "GB", "TB", "PB" };
            double value = bytes;
            var unit = 0;
            while (value >= 1024D && unit < units.Length - 1)
            {
                value /= 1024D;
                unit++;
            }
            return string.Format(value >= 100D || unit == 0 ? "{0:0} {1}" : "{0:0.0} {1}", value, units[unit]);
        }

        private string FormatOptionalBytes(long? bytes)
        {
            return bytes.HasValue ? FormatBytes(bytes.Value) : "Unavailable";
        }

        private string FormatOptionalNumber(long? value)
        {
            return value.HasValue ? value.Value.ToString("N0") : "Unavailable";
        }

        private string FormatPercent(long value, long total)
        {
            if (total <= 0) return "0%";
            return string.Format("{0:0.0}%", value * 100D / total);
        }

        private string EscapeSqlLiteral(string value)
        {
            return (value ?? string.Empty).Replace("'", "''");
        }

        private string UnescapeJson(string value)
        {
            if (value == null) return null;
            return value
                .Replace("\\\\", "\\")
                .Replace("\\\"", "\"")
                .Replace("\\r", "\r")
                .Replace("\\n", "\n")
                .Replace("\\t", "\t");
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private sealed class PostgresConfig
        {
            public string BinPath;
            public string Host;
            public string Port;
            public string User;
            public string Password;
            public string RisDb;
            public string PacsDb;
        }

        private sealed class BackupInfo
        {
            public string Label;
            public string Notes;
        }

        private sealed class StorageEstimate
        {
            public string Summary;
            public string Recommendation;
        }
    }

    internal static class PdfReportWriter
    {
        public static void Write(
            string outputPath,
            string logoPath,
            string hospitalName,
            DateTime generatedAt,
            string storageValue,
            string storageHint,
            string backupValue,
            string backupHint,
            string databaseValue,
            string databaseHint,
            string studyValue,
            string studyHint,
            string summary,
            string recommendation,
            MetricRow[] metrics)
        {
            var objects = new List<byte[]>();
            Func<string, int> addTextObject = text =>
            {
                objects.Add(Encoding.ASCII.GetBytes(text));
                return objects.Count;
            };

            var image = LoadLogoAsJpeg(logoPath);
            var imageObjectId = 0;
            if (image != null)
            {
                var header = string.Format(
                    "<< /Type /XObject /Subtype /Image /Width {0} /Height {1} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {2} >>\nstream\n",
                    image.Width,
                    image.Height,
                    image.Bytes.Length
                );
                var footer = "\nendstream";
                var bytes = Combine(Encoding.ASCII.GetBytes(header), image.Bytes, Encoding.ASCII.GetBytes(footer));
                objects.Add(bytes);
                imageObjectId = objects.Count;
            }

            var content = BuildContent(
                imageObjectId > 0,
                hospitalName,
                generatedAt,
                storageValue,
                storageHint,
                backupValue,
                backupHint,
                databaseValue,
                databaseHint,
                studyValue,
                studyHint,
                summary,
                recommendation,
                metrics ?? new MetricRow[0]
            );
            var contentBytes = Encoding.ASCII.GetBytes(content);
            objects.Add(Encoding.ASCII.GetBytes("<< /Length " + contentBytes.Length + " >>\nstream\n" + content + "\nendstream"));
            var contentObjectId = objects.Count;

            var fontRegularId = addTextObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
            var fontBoldId = addTextObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
            var pageId = objects.Count + 1;
            var pagesId = objects.Count + 2;
            var catalogId = objects.Count + 3;
            var resources = "<< /Font << /F1 " + fontRegularId + " 0 R /F2 " + fontBoldId + " 0 R >>";
            if (imageObjectId > 0) resources += " /XObject << /Logo " + imageObjectId + " 0 R >>";
            resources += " >>";
            addTextObject("<< /Type /Page /Parent " + pagesId + " 0 R /MediaBox [0 0 595 842] /Resources " + resources + " /Contents " + contentObjectId + " 0 R >>");
            addTextObject("<< /Type /Pages /Kids [" + pageId + " 0 R] /Count 1 >>");
            addTextObject("<< /Type /Catalog /Pages " + pagesId + " 0 R >>");

            WritePdf(outputPath, objects, catalogId);
        }

        private static string BuildContent(
            bool hasLogo,
            string hospitalName,
            DateTime generatedAt,
            string storageValue,
            string storageHint,
            string backupValue,
            string backupHint,
            string databaseValue,
            string databaseHint,
            string studyValue,
            string studyHint,
            string summary,
            string recommendation,
            MetricRow[] metrics)
        {
            var sb = new StringBuilder();
            Rect(sb, 0, 0, 595, 842, 8, 14, 28);
            Rect(sb, 28, 708, 539, 96, 15, 23, 42);
            Rect(sb, 28, 704, 539, 3, 34, 211, 238);
            if (hasLogo)
            {
                sb.AppendLine("q 58 0 0 58 42 728 cm /Logo Do Q");
            }
            Text(sb, "VEXA SYSTEM", 112, 765, 24, true, 255, 255, 255);
            Text(sb, "Infrastructure and Storage Health Report", 112, 742, 11, false, 148, 163, 184);
            Text(sb, Sanitize(hospitalName), 390, 768, 13, true, 34, 211, 238);
            Text(sb, "Generated: " + generatedAt.ToString("yyyy-MM-dd HH:mm"), 390, 747, 9, false, 203, 213, 225);

            Card(sb, 28, 594, 125, 86, "STORAGE", storageValue, storageHint, 34, 211, 238);
            Card(sb, 164, 594, 125, 86, "BACKUP", backupValue, backupHint, 168, 85, 247);
            Card(sb, 300, 594, 125, 86, "DATABASE", databaseValue, databaseHint, 34, 197, 94);
            Card(sb, 436, 594, 131, 86, "STUDIES", studyValue, studyHint, 251, 191, 36);

            Rect(sb, 28, 510, 539, 58, 15, 23, 42);
            Text(sb, "SYSTEM INSIGHT", 44, 548, 9, true, 34, 211, 238);
            WriteWrapped(sb, summary, 44, 529, 500, 10, false, 226, 232, 240, 2);

            Rect(sb, 28, 430, 539, 58, 8, 47, 73);
            Text(sb, "RECOMMENDATION", 44, 468, 9, true, 125, 211, 252);
            WriteWrapped(sb, recommendation, 44, 449, 500, 9.5f, false, 219, 234, 254, 2);

            Text(sb, "DETAILED METRICS", 28, 400, 12, true, 255, 255, 255);
            Rect(sb, 28, 374, 539, 20, 30, 41, 59);
            Text(sb, "Metric", 38, 381, 8.5f, true, 226, 232, 240);
            Text(sb, "Value", 188, 381, 8.5f, true, 226, 232, 240);
            Text(sb, "Notes", 318, 381, 8.5f, true, 226, 232, 240);
            var y = 350;
            foreach (var row in metrics.Take(12))
            {
                Rect(sb, 28, y - 4, 539, 22, y % 44 == 0 ? 15 : 18, y % 44 == 0 ? 23 : 28, y % 44 == 0 ? 42 : 48);
                Text(sb, Truncate(row.Metric, 26), 38, y + 3, 8.2f, false, 226, 232, 240);
                Text(sb, Truncate(row.Value, 22), 188, y + 3, 8.2f, false, 226, 232, 240);
                Text(sb, Truncate(row.Notes, 42), 318, y + 3, 8.2f, false, 226, 232, 240);
                y -= 24;
                if (y < 62) break;
            }
            Text(sb, "VEXA SYSTEM - confidential operational report", 28, 32, 8, false, 100, 116, 139);
            Text(sb, "Generated by Vexa System Utility", 410, 32, 8, false, 100, 116, 139);
            return sb.ToString();
        }

        private static void Card(StringBuilder sb, int x, int y, int width, int height, string title, string value, string hint, int r, int g, int b)
        {
            Rect(sb, x, y, width, height, 15, 23, 42);
            Rect(sb, x, y, 4, height, r, g, b);
            Text(sb, title, x + 14, y + height - 24, 8.5f, true, r, g, b);
            Text(sb, Truncate(value, 12), x + 14, y + height - 53, 18, true, 255, 255, 255);
            WriteWrapped(sb, hint, x + 14, y + 18, width - 24, 7.2f, false, 203, 213, 225, 2);
        }

        private static void Rect(StringBuilder sb, int x, int y, int width, int height, int r, int g, int b)
        {
            sb.AppendFormat(System.Globalization.CultureInfo.InvariantCulture, "q {0:0.###} {1:0.###} {2:0.###} rg {3} {4} {5} {6} re f Q\n", r / 255D, g / 255D, b / 255D, x, y, width, height);
        }

        private static void Text(StringBuilder sb, string text, float x, float y, float size, bool bold, int r, int g, int b)
        {
            sb.AppendFormat(System.Globalization.CultureInfo.InvariantCulture, "BT {0:0.###} {1:0.###} {2:0.###} rg /{3} {4:0.###} Tf {5:0.###} {6:0.###} Td ({7}) Tj ET\n", r / 255D, g / 255D, b / 255D, bold ? "F2" : "F1", size, x, y, EscapePdfText(text));
        }

        private static void WriteWrapped(StringBuilder sb, string text, float x, float y, float width, float size, bool bold, int r, int g, int b, int maxLines)
        {
            var words = Sanitize(text).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            var line = string.Empty;
            var lineCount = 0;
            var maxChars = Math.Max(12, (int)(width / (size * 0.52f)));
            foreach (var word in words)
            {
                var next = string.IsNullOrEmpty(line) ? word : line + " " + word;
                if (next.Length > maxChars)
                {
                    Text(sb, line, x, y - (lineCount * (size + 3)), size, bold, r, g, b);
                    line = word;
                    lineCount++;
                    if (lineCount >= maxLines) return;
                }
                else
                {
                    line = next;
                }
            }
            if (line.Length > 0 && lineCount < maxLines)
            {
                Text(sb, line, x, y - (lineCount * (size + 3)), size, bold, r, g, b);
            }
        }

        private static string Truncate(string text, int max)
        {
            text = Sanitize(text);
            if (text.Length <= max) return text;
            return text.Substring(0, Math.Max(0, max - 3)) + "...";
        }

        private static string Sanitize(string text)
        {
            if (string.IsNullOrEmpty(text)) return string.Empty;
            var sb = new StringBuilder();
            foreach (var ch in text)
            {
                sb.Append(ch >= 32 && ch <= 126 ? ch : ' ');
            }
            return Regex.Replace(sb.ToString(), "\\s+", " ").Trim();
        }

        private static string EscapePdfText(string text)
        {
            return Sanitize(text).Replace("\\", "\\\\").Replace("(", "\\(").Replace(")", "\\)");
        }

        private static PdfImage LoadLogoAsJpeg(string logoPath)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(logoPath) || !File.Exists(logoPath)) return null;
                using (var bitmap = new Bitmap(logoPath))
                using (var flattened = new Bitmap(bitmap.Width, bitmap.Height))
                using (var graphics = Graphics.FromImage(flattened))
                using (var stream = new MemoryStream())
                {
                    graphics.Clear(Color.White);
                    graphics.DrawImage(bitmap, 0, 0, bitmap.Width, bitmap.Height);
                    flattened.Save(stream, ImageFormat.Jpeg);
                    return new PdfImage { Bytes = stream.ToArray(), Width = flattened.Width, Height = flattened.Height };
                }
            }
            catch
            {
                return null;
            }
        }

        private static byte[] Combine(params byte[][] arrays)
        {
            var length = arrays.Sum(item => item.Length);
            var result = new byte[length];
            var offset = 0;
            foreach (var item in arrays)
            {
                Buffer.BlockCopy(item, 0, result, offset, item.Length);
                offset += item.Length;
            }
            return result;
        }

        private static void WritePdf(string outputPath, List<byte[]> objects, int catalogId)
        {
            using (var stream = new FileStream(outputPath, FileMode.Create, FileAccess.Write))
            {
                WriteAscii(stream, "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
                var offsets = new List<long> { 0 };
                for (var i = 0; i < objects.Count; i++)
                {
                    offsets.Add(stream.Position);
                    WriteAscii(stream, (i + 1) + " 0 obj\n");
                    stream.Write(objects[i], 0, objects[i].Length);
                    WriteAscii(stream, "\nendobj\n");
                }
                var xref = stream.Position;
                WriteAscii(stream, "xref\n0 " + (objects.Count + 1) + "\n");
                WriteAscii(stream, "0000000000 65535 f \n");
                for (var i = 1; i < offsets.Count; i++)
                {
                    WriteAscii(stream, offsets[i].ToString("0000000000") + " 00000 n \n");
                }
                WriteAscii(stream, "trailer\n<< /Size " + (objects.Count + 1) + " /Root " + catalogId + " 0 R >>\nstartxref\n" + xref + "\n%%EOF");
            }
        }

        private static void WriteAscii(Stream stream, string text)
        {
            var bytes = Encoding.ASCII.GetBytes(text);
            stream.Write(bytes, 0, bytes.Length);
        }

        private sealed class PdfImage
        {
            public byte[] Bytes;
            public int Width;
            public int Height;
        }
    }
}
