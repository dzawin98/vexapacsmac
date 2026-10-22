const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseJsonOrBlock } = require('./licenseEnvelope');

// Direktori data program lintas platform.
// Windows: <ProgramData>\VEXAPACS.  macOS: ~/Library/Application Support/VEXAPACS.
function resolveProgramDataDir() {
  const explicit = String(process.env.VEXA_PROGRAM_DATA_DIR || '').trim();
  if (explicit) return explicit;
  const winProgramData = process.env.ProgramData || process.env.PROGRAMDATA;
  if (winProgramData) return path.join(winProgramData, 'VEXAPACS');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'VEXAPACS');
  }
  return path.join(os.homedir(), '.vexapacs');
}

const DEFAULT_LICENSE_PATH = path.join(resolveProgramDataDir(), 'license.lic');
const DEFAULT_MODULES = Object.freeze([
  'RIS',
  'PACS_DIMSE',
  'PACS_MWL',
  'DESKTOP_VIEWER',
  'MOBILE_VIEWER',
  'ECG_VIEWER',
]);

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, 'base64');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readWindowsMachineGuid() {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ], { encoding: 'utf8', windowsHide: true });
    const match = output.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function getPrimaryMacAddresses() {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces)
    .flat()
    .filter(Boolean)
    .filter((entry) => !entry.internal && entry.mac && entry.mac !== '00:00:00:00:00:00')
    .map((entry) => entry.mac.toLowerCase())
    .sort();
}

function getMachineFingerprintParts() {
  const cpus = os.cpus() || [];
  return {
    machineGuid: readWindowsMachineGuid(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model || '',
    macs: getPrimaryMacAddresses(),
  };
}

function getMachineId(salt = 'VEXAPACS-RIS') {
  const parts = getMachineFingerprintParts();
  return sha256(`${salt}|${canonicalJson(parts)}`);
}

function createInstallRequest(options = {}) {
  const machineId = options.machineId || getMachineId(options.salt);
  return {
    schema: 'vexapacs.install-request.v1',
    generatedAt: new Date().toISOString(),
    machineId,
    machine: getMachineFingerprintParts(),
    requestedModules: normalizeModules(options.modules || DEFAULT_MODULES),
    installerVersion: options.installerVersion || 'dev',
    note: options.note || '',
  };
}

function normalizeModules(modules) {
  const values = Array.isArray(modules)
    ? modules
    : String(modules || '').split(',');
  return [...new Set(values.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))].sort();
}

function createSignedLicense(payload, privateKeyPem, options = {}) {
  const licensePayload = {
    schema: 'vexapacs.license.v1',
    licenseId: payload.licenseId || `VEXA-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    customerId: payload.customerId || '',
    customerName: payload.customerName || '',
    issuedAt: payload.issuedAt || new Date().toISOString(),
    notBefore: payload.notBefore || new Date().toISOString(),
    expiresAt: payload.expiresAt || null,
    machineId: payload.machineId || '',
    modules: normalizeModules(payload.modules || []),
    maxUsers: Number.isFinite(Number(payload.maxUsers)) ? Number(payload.maxUsers) : null,
    features: payload.features && typeof payload.features === 'object' ? payload.features : {},
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
  };

  const signedData = canonicalJson(licensePayload);
  const signature = crypto.sign(null, Buffer.from(signedData), privateKeyPem);
  return {
    alg: 'Ed25519',
    kid: options.keyId || 'vexapacs-prod-1',
    payload: licensePayload,
    signature: base64url(signature),
  };
}

function verifyLicenseObject(license, publicKeyPem, options = {}) {
  const result = {
    ok: false,
    reason: '',
    payload: null,
  };

  if (!license || typeof license !== 'object') {
    return { ...result, reason: 'LICENSE_MISSING' };
  }
  if (license.alg !== 'Ed25519' || !license.payload || !license.signature) {
    return { ...result, reason: 'LICENSE_FORMAT_INVALID' };
  }

  const signedData = canonicalJson(license.payload);
  const signatureOk = crypto.verify(
    null,
    Buffer.from(signedData),
    publicKeyPem,
    fromBase64url(license.signature)
  );
  if (!signatureOk) {
    return { ...result, reason: 'SIGNATURE_INVALID' };
  }

  const now = options.now ? new Date(options.now) : new Date();
  const payload = license.payload;
  if (payload.notBefore && now < new Date(payload.notBefore)) {
    return { ...result, reason: 'LICENSE_NOT_ACTIVE', payload };
  }
  if (payload.expiresAt && now > new Date(payload.expiresAt)) {
    return { ...result, reason: 'LICENSE_EXPIRED', payload };
  }

  const expectedMachineId = options.machineId || getMachineId(options.salt);
  if (payload.machineId && payload.machineId !== expectedMachineId) {
    return { ...result, reason: 'MACHINE_ID_MISMATCH', payload };
  }

  const requiredModule = String(options.requiredModule || '').trim().toUpperCase();
  if (requiredModule && !normalizeModules(payload.modules).includes(requiredModule)) {
    return { ...result, reason: 'MODULE_NOT_LICENSED', payload };
  }

  return { ok: true, reason: 'OK', payload };
}

function readJsonFile(filePath) {
  return parseJsonOrBlock(fs.readFileSync(filePath, 'utf8'));
}

function loadLicense(filePath = process.env.VEXA_LICENSE_FILE || process.env.VELO_LICENSE_FILE || DEFAULT_LICENSE_PATH) {
  return readJsonFile(filePath);
}

function loadPublicKey(filePath = process.env.VEXA_LICENSE_PUBLIC_KEY_PATH || process.env.VELO_LICENSE_PUBLIC_KEY_PATH) {
  if (!filePath) {
    throw new Error('VEXA_LICENSE_PUBLIC_KEY_PATH is not set.');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function verifyLicenseFile(options = {}) {
  const license = loadLicense(options.licensePath);
  const publicKey = options.publicKey || loadPublicKey(options.publicKeyPath);
  return verifyLicenseObject(license, publicKey, options);
}

function assertLicensed(requiredModule, options = {}) {
  const result = verifyLicenseFile({ ...options, requiredModule });
  if (!result.ok) {
    const error = new Error(`License invalid: ${result.reason}`);
    error.code = result.reason;
    error.license = result.payload;
    throw error;
  }
  return result.payload;
}

function createLicenseMiddleware(requiredModule, options = {}) {
  return (req, res, next) => {
    try {
      req.license = assertLicensed(requiredModule, options);
      next();
    } catch (err) {
      res.status(403).json({
        error: 'This license is not valid for this module.',
        code: err.code || 'LICENSE_INVALID',
      });
    }
  };
}

module.exports = {
  DEFAULT_LICENSE_PATH,
  DEFAULT_MODULES,
  assertLicensed,
  canonicalJson,
  createInstallRequest,
  createLicenseMiddleware,
  createSignedLicense,
  getMachineFingerprintParts,
  getMachineId,
  loadLicense,
  normalizeModules,
  verifyLicenseFile,
  verifyLicenseObject,
};
