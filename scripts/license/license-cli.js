#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_MODULES,
  createInstallRequest,
  createSignedLicense,
  getMachineId,
  loadLicense,
  normalizeModules,
  verifyLicenseObject,
} = require('./licenseCore');
const { encodeBlock, parseJsonOrBlock } = require('./licenseEnvelope');
const { verifyRuntimeModule } = require('./licenseRuntime');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return parseJsonOrBlock(fs.readFileSync(filePath, 'utf8'));
}

function usage() {
  console.log(`
VEXAPACS License CLI

Commands:
  machine
    Show this server's Machine ID.

  request --out install-request.json [--code-out install-request.txt] [--format json|code] [--modules RIS,PACS_DIMSE]
    Create a request code/file from the hospital server.

  generate-keys --out ./keys [--key-id vexapacs-prod-1]
    Create an Ed25519 private/public key pair. Keep the private key in your own office/team.

  sign --request install-request.json --private-key ./keys/private.pem --customer "Demo Hospital" --modules RIS,PACS_DIMSE --expires 2027-06-17 --out license.lic [--format json|code]
    Generate a signed license for a customer.

  verify --license license.lic --public-key ./keys/public.pem [--module RIS]
    Validate the signature, expiry, machine binding, and module entitlement.

  check --module RIS
    Runtime check using the VEXA_LICENSE_* environment. Exit 0 when enforcement is off.

Known modules:
  ${DEFAULT_MODULES.join(', ')}
`.trim());
}

function commandMachine() {
  console.log(getMachineId());
}

function commandRequest(args) {
  const request = createInstallRequest({
    modules: args.modules ? normalizeModules(args.modules) : DEFAULT_MODULES,
    installerVersion: args['installer-version'] || 'dev',
    note: args.note || '',
  });
  const format = String(args.format || 'json').toLowerCase();
  if (args.out) {
    const outPath = path.resolve(args.out);
    if (format === 'code') {
      ensureDir(path.dirname(outPath));
      fs.writeFileSync(outPath, encodeBlock(request, 'request'), 'utf8');
    } else {
      writeJson(outPath, request);
    }
    console.log(`Install request written: ${path.resolve(args.out)}`);
  }
  if (args['code-out']) {
    const codePath = path.resolve(args['code-out']);
    ensureDir(path.dirname(codePath));
    fs.writeFileSync(codePath, encodeBlock(request, 'request'), 'utf8');
    console.log(`Install request code written: ${codePath}`);
  }
  if (!args.out) {
    console.log(format === 'code' ? encodeBlock(request, 'request') : JSON.stringify(request, null, 2));
  }
}

function commandGenerateKeys(args) {
  const outDir = path.resolve(args.out || path.join(__dirname, 'keys'));
  ensureDir(outDir);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(
    path.join(outDir, 'private.pem'),
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { encoding: 'utf8', mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(outDir, 'public.pem'),
    publicKey.export({ type: 'spki', format: 'pem' }),
    'utf8'
  );
  writeJson(path.join(outDir, 'key-info.json'), {
    keyId: args['key-id'] || 'vexapacs-prod-1',
    algorithm: 'Ed25519',
    createdAt: new Date().toISOString(),
  });
  console.log(`Keypair written to: ${outDir}`);
  console.log('IMPORTANT: never ship private.pem with the installer and never send it to a customer.');
}

function commandSign(args) {
  if (!args.request) throw new Error('--request is required.');
  if (!args['private-key']) throw new Error('--private-key is required.');
  if (!args.customer) throw new Error('--customer is required.');
  if (!args.out) throw new Error('--out is required.');

  const request = readJson(path.resolve(args.request));
  const privateKey = fs.readFileSync(path.resolve(args['private-key']), 'utf8');
  const modules = args.modules
    ? normalizeModules(args.modules)
    : normalizeModules(request.requestedModules || []);
  const license = createSignedLicense({
    licenseId: args['license-id'],
    customerId: args['customer-id'] || '',
    customerName: args.customer,
    expiresAt: args.expires || null,
    machineId: request.machineId,
    modules,
    maxUsers: args['max-users'],
    metadata: {
      generatedFromRequestAt: request.generatedAt,
      generatedBy: args['generated-by'] || osUser(),
    },
  }, privateKey, {
    keyId: args['key-id'] || 'vexapacs-prod-1',
  });

  const outPath = path.resolve(args.out);
  if (String(args.format || 'json').toLowerCase() === 'code') {
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, encodeBlock(license, 'license'), 'utf8');
  } else {
    writeJson(outPath, license);
  }
  console.log(`License written: ${path.resolve(args.out)}`);
  console.log(`Customer: ${license.payload.customerName}`);
  console.log(`Modules: ${license.payload.modules.join(', ')}`);
  console.log(`Expires: ${license.payload.expiresAt || 'lifetime'}`);
}

function osUser() {
  try {
    return require('os').userInfo().username;
  } catch {
    return 'unknown';
  }
}

function commandVerify(args) {
  if (!args.license) throw new Error('--license is required.');
  if (!args['public-key']) throw new Error('--public-key is required.');
  const license = loadLicense(path.resolve(args.license));
  const publicKey = fs.readFileSync(path.resolve(args['public-key']), 'utf8');
  const result = verifyLicenseObject(license, publicKey, {
    requiredModule: args.module || '',
    machineId: args['machine-id'] || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 2;
}

function commandCheck(args) {
  if (!args.module) throw new Error('--module is required.');
  const result = verifyRuntimeModule(args.module);
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ ok: true, reason: result.reason, module: String(args.module).toUpperCase() }, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case 'machine':
      return commandMachine(args);
    case 'request':
      return commandRequest(args);
    case 'generate-keys':
      return commandGenerateKeys(args);
    case 'sign':
      return commandSign(args);
    case 'verify':
      return commandVerify(args);
    case 'check':
      return commandCheck(args);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return usage();
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
