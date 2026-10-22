const path = require('path');
const { verifyLicenseFile } = require('./licenseCore');

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isFalsy(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function shouldEnforceLicense() {
  const enforceValue = process.env.VEXA_LICENSE_ENFORCE ?? process.env.VELO_LICENSE_ENFORCE;
  if (isFalsy(enforceValue)) return false;
  if (isTruthy(enforceValue)) return true;
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

function defaultPublicKeyPath() {
  const explicit = String(process.env.VEXA_PROGRAM_DATA_DIR || '').trim();
  if (explicit) return path.join(explicit, 'VEXAPACS', 'public.pem');
  const winProgramData = process.env.ProgramData || process.env.PROGRAMDATA;
  if (winProgramData) return path.join(winProgramData, 'VEXAPACS', 'public.pem');
  if (process.platform === 'darwin') {
    return path.join(require('os').homedir(), 'Library', 'Application Support', 'VEXAPACS', 'public.pem');
  }
  return path.join(require('os').homedir(), '.vexapacs', 'public.pem');
}

function enforceLicenseAtStartup(requiredModule, options = {}) {
  const moduleName = String(requiredModule || '').trim().toUpperCase();
  if (!moduleName) {
    throw new Error('requiredModule is required for license enforcement.');
  }

  if (!shouldEnforceLicense()) {
    const logSkipped = process.env.VEXA_LICENSE_LOG_SKIPPED ?? process.env.VELO_LICENSE_LOG_SKIPPED;
    if (logSkipped !== '0') {
      console.warn(`[license] Enforcement is not active for module ${moduleName}. Set VEXA_LICENSE_ENFORCE=true in production.`);
    }
    return null;
  }

  const result = verifyRuntimeModule(moduleName, options);

  if (!result.ok) {
    const message = `[license] Invalid license for module ${moduleName}: ${result.reason}${result.error ? ` (${result.error})` : ''}`;
    console.error(message);
    const error = new Error(message);
    error.code = result.reason;
    throw error;
  }

  const payload = result.payload || {};
  console.log(`[license] OK ${moduleName} - ${payload.customerName || payload.customerId || payload.licenseId || 'licensed'}`);
  return payload;
}

function verifyRuntimeModule(requiredModule, options = {}) {
  const moduleName = String(requiredModule || '').trim().toUpperCase();
  if (!moduleName) {
    return { ok: false, reason: 'MODULE_REQUIRED', payload: null };
  }
  if (!shouldEnforceLicense()) {
    return { ok: true, reason: 'ENFORCEMENT_DISABLED', payload: null };
  }
  try {
    return verifyLicenseFile({
      requiredModule: moduleName,
      licensePath: options.licensePath || process.env.VEXA_LICENSE_FILE || process.env.VELO_LICENSE_FILE,
      publicKeyPath: options.publicKeyPath || process.env.VEXA_LICENSE_PUBLIC_KEY_PATH || process.env.VELO_LICENSE_PUBLIC_KEY_PATH || defaultPublicKeyPath(),
      salt: options.salt,
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'LICENSE_FILE_ERROR',
      payload: null,
      error: error?.message || String(error),
    };
  }
}

module.exports = {
  enforceLicenseAtStartup,
  shouldEnforceLicense,
  verifyRuntimeModule,
};
