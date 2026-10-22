const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.BACKUP_AGENT_PORT || 3099);
const PROGRAM_DATA_DIR = process.env.VEXA_PROGRAM_DATA_DIR || path.join(ROOT_DIR, '.programdata');
const CONFIG_PATH = process.env.VEXA_BACKUP_CONFIG_PATH || path.join(PROGRAM_DATA_DIR, 'backup.config.json');
const BACKUP_SCRIPT_PATH = process.env.VEXA_BACKUP_SCRIPT_PATH || path.join(ROOT_DIR, 'installer', 'scripts', 'backup', 'backup.ps1');
const RESTORE_SCRIPT_PATH = process.env.VEXA_RESTORE_SCRIPT_PATH || path.join(ROOT_DIR, 'installer', 'scripts', 'backup', 'restore.ps1');
const BACKUP_TASK_NAME = process.env.VEXA_BACKUP_TASK_NAME || 'VEXAPACS Daily Backup';
const JOBS_PATH = path.join(PROGRAM_DATA_DIR, 'backup-agent-jobs.json');

const app = express();
app.use(express.json({ limit: '2mb' }));

let runtimeJob = null;

function defaultConfig() {
  return {
    backupRoot: 'D:\\VEXAPACS-Backup',
    dataPath: process.env.DICOM_STORAGE_PATH || path.join(ROOT_DIR, 'DATA'),
    programDataPath: PROGRAM_DATA_DIR,
    includeDicomData: true,
    includeProgramData: true,
    postgres: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASS || 'velo',
      risDb: process.env.DB_NAME || 'vexaris_db',
      pacsDb: process.env.PACS_DB_NAME || 'vexapacs_db',
      binPath: process.env.POSTGRES_BIN_PATH || '',
    },
    services: [
      'VexaRISBackend',
      'VexaRISFrontend',
      'VexaPacsDicomweb',
      'VexaPacsDimse',
      'VexaMwlService',
      'VexaDesktopViewer',
      'VexaMobileViewer',
      'VexaEcgViewer',
      'VexaCaddy',
    ],
    retention: { keepLast: 7 },
    schedule: {
      // Mirrors RIS/backend/index.js defaultBackupConfig(): backups are on by
      // default, and the installer registers the Windows task at install time.
      enabled: true,
      frequency: 'daily',
      time: '23:00',
      interval: 1,
      daysOfWeek: ['MON'],
      dayOfMonth: 1,
    },
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readConfig() {
  ensureDir(PROGRAM_DATA_DIR);
  const config = mergeConfig(defaultConfig(), readJson(CONFIG_PATH, {}));
  if (!fs.existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, config);
  return config;
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...(override || {}),
    postgres: { ...base.postgres, ...((override || {}).postgres || {}) },
    retention: { ...base.retention, ...((override || {}).retention || {}) },
    schedule: { ...base.schedule, ...((override || {}).schedule || {}) },
  };
}

function publicConfig(config = readConfig()) {
  return {
    ...config,
    postgres: {
      ...(config.postgres || {}),
      password: config.postgres?.password ? '********' : '',
      passwordConfigured: Boolean(config.postgres?.password),
    },
    configPath: CONFIG_PATH,
    backupScriptPath: BACKUP_SCRIPT_PATH,
    restoreScriptPath: RESTORE_SCRIPT_PATH,
  };
}

function saveConfig(payload) {
  const current = readConfig();
  const next = mergeConfig(current, payload || {});
  writeJson(CONFIG_PATH, next);
  return next;
}

function parseProgress(output, running, exitCode) {
  const matches = [...String(output || '').matchAll(/\[PROGRESS\]\s+(\d{1,3})\s+(.+)/g)];
  if (matches.length) {
    const latest = matches[matches.length - 1];
    return {
      percent: Math.max(0, Math.min(100, Number(latest[1]))),
      message: String(latest[2] || '').trim(),
    };
  }
  if (running) return { percent: 5, message: 'Running...' };
  if (exitCode === 0) return { percent: 100, message: 'Completed' };
  return null;
}

function jobStatus() {
  if (!runtimeJob) return { running: false };
  return {
    running: runtimeJob.running,
    type: runtimeJob.type,
    startedAt: runtimeJob.startedAt,
    finishedAt: runtimeJob.finishedAt || null,
    exitCode: runtimeJob.exitCode,
    error: runtimeJob.error || null,
    output: String(runtimeJob.output || '').slice(-8000),
    progress: parseProgress(runtimeJob.output, runtimeJob.running, runtimeJob.exitCode),
  };
}

function readJobs() {
  return readJson(JOBS_PATH, []);
}

function writeJobs(jobs) {
  writeJson(JOBS_PATH, jobs.slice(0, 200));
}

function createJobLog(type, backupPath, requestedBy) {
  const jobs = readJobs();
  const id = Date.now();
  jobs.unshift({
    id,
    job_type: type,
    status: 'running',
    backup_path: backupPath || null,
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    progress_percent: 5,
    progress_message: 'Running...',
    requested_by: requestedBy || null,
  });
  writeJobs(jobs);
  return id;
}

function updateJobLog(id, job) {
  if (!id) return;
  const jobs = readJobs();
  const target = jobs.find(item => item.id === id);
  if (!target) return;
  const progress = parseProgress(job.output, job.running, job.exitCode);
  target.status = job.running ? 'running' : (job.exitCode === 0 ? 'success' : 'failed');
  target.finished_at = job.running ? null : new Date().toISOString();
  target.exit_code = job.exitCode ?? null;
  target.progress_percent = progress?.percent ?? target.progress_percent ?? null;
  target.progress_message = progress?.message || job.error || target.progress_message || null;
  writeJobs(jobs);
}

function listBackups(config = readConfig()) {
  const backupRoot = String(config.backupRoot || '').trim();
  if (!backupRoot || !fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const backupPath = path.join(backupRoot, entry.name);
      const manifestPath = path.join(backupPath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) return null;
      const manifest = readJson(manifestPath, null);
      if (!manifest) return { name: entry.name, path: backupPath, createdAt: null, invalid: true };
      return {
        name: entry.name,
        path: backupPath,
        createdAt: manifest.createdAt || null,
        backupVersion: manifest.backupVersion || null,
        includeDicomData: Boolean(manifest.includeDicomData),
        includeProgramData: Boolean(manifest.includeProgramData),
        databases: manifest.databases || {},
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

function scheduleStatus() {
  const configured = readConfig().schedule || defaultConfig().schedule;
  if (process.platform !== 'win32') {
    // macOS/Linux: jadwal otomatis memakai launchd (lihat installationintructionmac.md).
    // Agent hanya melaporkan konfigurasi; tidak ada task OS yang didaftarkan.
    return {
      ...configured,
      enabled: Boolean(configured.enabled),
      taskName: BACKUP_TASK_NAME,
      scheduler: 'launchd',
      installed: false,
      note: 'Jadwal otomatis di macOS memakai launchd; lihat mac/backup/install-launchd.sh',
    };
  }
  try {
    const output = execFileSync('schtasks.exe', ['/Query', '/TN', BACKUP_TASK_NAME, '/FO', 'LIST'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return { ...configured, enabled: true, taskName: BACKUP_TASK_NAME, raw: output };
  } catch (error) {
    return {
      ...configured,
      enabled: false,
      taskName: BACKUP_TASK_NAME,
      error: error.message || 'Schedule task was not found',
    };
  }
}

// Skrip backup/restore berbeda per platform: PowerShell di Windows, bash di macOS/Linux.
function scriptRunner(scriptPath, args) {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      argv: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    };
  }
  if (/\.sh$/i.test(scriptPath)) {
    return { command: '/bin/bash', argv: [scriptPath, ...args] };
  }
  return { command: 'pwsh', argv: ['-NoProfile', '-File', scriptPath, ...args] };
}

function runPowerShellJob(type, scriptPath, args, backupPath, requestedBy) {
  if (runtimeJob?.running) {
    const error = new Error(`${runtimeJob.type} is already running`);
    error.status = 409;
    throw error;
  }
  if (!fs.existsSync(scriptPath)) {
    const error = new Error(`Script was not found: ${scriptPath}`);
    error.status = 500;
    throw error;
  }
  const logId = createJobLog(type, backupPath, requestedBy);
  const runner = scriptRunner(scriptPath, args);
  const child = spawn(runner.command, runner.argv, {
    windowsHide: true,
  });
  const job = {
    running: true,
    type,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    output: '',
    child,
    logId,
  };
  runtimeJob = job;
  const append = data => {
    job.output += data.toString();
    if (job.output.length > 12000) job.output = job.output.slice(-12000);
    updateJobLog(logId, job);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', error => {
    job.running = false;
    job.finishedAt = new Date().toISOString();
    job.error = error.message;
    updateJobLog(logId, job);
  });
  child.on('close', code => {
    job.running = false;
    job.finishedAt = new Date().toISOString();
    job.exitCode = code;
    updateJobLog(logId, job);
  });
  return jobStatus();
}

function username(req) {
  return String(req.headers['x-user-username'] || '').slice(0, 100) || null;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'VexaBackupAgent' }));
app.get('/api/system/backup/config', (_req, res) => res.json({ config: publicConfig() }));
app.put('/api/system/backup/config', (req, res) => res.json({ config: publicConfig(saveConfig(req.body || {})) }));
app.get('/api/system/backup/list', (_req, res) => res.json({ backups: listBackups() }));
app.get('/api/system/backup/status', (_req, res) => res.json({ job: jobStatus(), schedule: scheduleStatus() }));
app.get('/api/system/backup/jobs', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  res.json({ jobs: readJobs().slice(0, limit) });
});
app.post('/api/system/backup/run', (req, res) => {
  try {
    const args = ['-ConfigPath', CONFIG_PATH, '-NoStopServices'];
    if (req.body?.skipDicomData) args.push('-SkipDicomData');
    if (req.body?.skipProgramData) args.push('-SkipProgramData');
    const status = runPowerShellJob('backup', BACKUP_SCRIPT_PATH, args, null, username(req));
    res.status(202).json({ job: status });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to start backup' });
  }
});
app.post('/api/system/restore/run', (req, res) => {
  try {
    const backupPath = String(req.body?.backupPath || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim();
    if (!backupPath) return res.status(400).json({ error: 'Backup path is required' });
    if (confirmation !== 'RESTORE') return res.status(400).json({ error: 'Type RESTORE to confirm restore' });
    const args = ['-BackupPath', backupPath, '-ConfigPath', CONFIG_PATH, '-ConfirmRestore', '-NoStopServices'];
    if (req.body?.skipDatabase) args.push('-SkipDatabase');
    if (req.body?.skipDicomData) args.push('-SkipDicomData');
    if (req.body?.skipProgramData) args.push('-SkipProgramData');
    if (req.body?.noStartServices) args.push('-NoStartServices');
    const status = runPowerShellJob('restore', RESTORE_SCRIPT_PATH, args, backupPath, username(req));
    res.status(202).json({ job: status });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to start restore' });
  }
});
app.get('/api/system/backup/schedule', (_req, res) => res.json({ schedule: scheduleStatus() }));
app.post('/api/system/backup/schedule', (req, res) => {
  const current = readConfig();
  const schedule = { ...(current.schedule || {}), ...(req.body?.schedule || req.body || {}), enabled: true };
  saveConfig({ ...current, schedule });
  res.json({ schedule: { ...scheduleStatus(), ...schedule } });
});
app.delete('/api/system/backup/schedule', (_req, res) => {
  const current = readConfig();
  const schedule = { ...(current.schedule || {}), enabled: false };
  saveConfig({ ...current, schedule });
  res.json({ schedule: { ...scheduleStatus(), ...schedule } });
});

app.listen(PORT, '0.0.0.0', () => {
  ensureDir(PROGRAM_DATA_DIR);
  console.log(`Vexa Backup Agent listening on http://0.0.0.0:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
