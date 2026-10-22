/**
 * Measure hashing a large file read-whole vs streamed.
 *
 * A DICOM Manager operation hashes every source file at `begin` and every output file
 * at `complete`, so peak memory here is per-object memory inside the RIS backend. The
 * digests must be identical: restore preflight compares the stored hashes.
 *
 * Each mode runs in its own process: Buffer memory is external and only released by
 * GC, so measuring both in one process would charge the second run for the first run's
 * garbage.
 *
 * Usage:
 *   node scripts/bench-sha256-file.js [--mb=256] [--chunk-kb=1024]
 *   node scripts/bench-sha256-file.js --mode=whole|streamed --file=<path>   (internal)
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function arg(name) {
  const raw = process.argv.find(entry => entry.startsWith(`--${name}=`));
  return raw ? raw.split('=').slice(1).join('=') : null;
}

function numberArg(name, fallback) {
  const value = Number(arg(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MODE = arg('mode');
const CHUNK_KB = numberArg('chunk-kb', 1024);
process.env.DICOMWEB_SHA256_CHUNK_BYTES = String(CHUNK_KB * 1024);

const service = require('../src/services/dicomwebPacsService');

function startMemorySampler() {
  const samples = [];
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    samples.push({
      rss: usage.rss,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers || 0,
    });
  }, 5);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    const peak = key => samples.reduce((max, sample) => Math.max(max, sample[key] || 0), 0);
    return {
      peakRssMb: Number((peak('rss') / 1048576).toFixed(1)),
      peakExternalMb: Number((peak('external') / 1048576).toFixed(1)),
      peakArrayBuffersMb: Number((peak('arrayBuffers') / 1048576).toFixed(1)),
      samples: samples.length,
    };
  };
}

/** Child mode: hash the given file once (or N times in parallel) and report. */
async function runSingleMode(filePath) {
  const parallel = Math.max(numberArg('parallel', 1), 1);
  const stop = startMemorySampler();
  const startedAt = Date.now();
  const digests = await Promise.all(Array.from({ length: parallel }, () => (
    MODE === 'whole'
      ? fsp.readFile(filePath).then(content => crypto.createHash('sha256').update(content).digest('hex'))
      : service.sha256File(filePath)
  )));
  const durationMs = Date.now() - startedAt;
  const peaks = stop();
  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    parallel,
    durationMs,
    digest: digests[0],
    digestsConsistent: digests.every(digest => digest === digests[0]),
    peaks,
  })}\n`);
}

async function writePayload(filePath, sizeMb) {
  const chunkBytes = 4 * 1024 * 1024;
  const totalBytes = sizeMb * 1024 * 1024;
  const handle = await fsp.open(filePath, 'w');
  try {
    for (let written = 0; written < totalBytes; written += chunkBytes) {
      const size = Math.min(chunkBytes, totalBytes - written);
      const buffer = crypto.randomBytes(size);
      // Embed the offset so the file cannot be a repeated pattern.
      buffer.writeUInt32LE(written % 0xffffffff, 0);
      await handle.write(buffer, 0, size, written);
    }
  } finally {
    await handle.close();
  }
}

function runChildMode(mode, filePath) {
  const result = spawnSync(process.execPath, [
    '--expose-gc',
    __filename,
    `--mode=${mode}`,
    `--file=${filePath}`,
    `--chunk-kb=${CHUNK_KB}`,
    `--parallel=${Math.max(numberArg('parallel', 1), 1)}`,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${mode} run failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '').split(/\r?\n/).filter(entry => entry.trim().startsWith('{')).pop();
  if (!line) throw new Error(`${mode} run produced no measurement`);
  return JSON.parse(line);
}

(async () => {
  const filePath = arg('file');
  if (MODE) {
    if (!filePath) throw new Error('--file is required in --mode runs');
    await runSingleMode(filePath);
    return;
  }

  const sizeMb = numberArg('mb', 256);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexia-sha256-bench-'));
  const payloadPath = path.join(tempDir, `payload-${sizeMb}mb.bin`);
  await writePayload(payloadPath, sizeMb);
  const stat = await fsp.stat(payloadPath);

  const whole = runChildMode('whole', payloadPath);
  const streamed = runChildMode('streamed', payloadPath);
  await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  const result = {
    fileMb: Number((stat.size / 1048576).toFixed(1)),
    chunkKb: CHUNK_KB,
    readWhole: whole,
    streamed,
    digestsMatch: whole.digest === streamed.digest,
    peakExternalReductionMb: Number((whole.peaks.peakExternalMb - streamed.peaks.peakExternalMb).toFixed(1)),
    peakRssReductionMb: Number((whole.peaks.peakRssMb - streamed.peaks.peakRssMb).toFixed(1)),
  };
  result.passed = result.digestsMatch === true
    && streamed.peaks.peakExternalMb < whole.peaks.peakExternalMb / 2
    && streamed.durationMs < whole.durationMs * 1.5;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.passed ? 0 : 1);
})().catch(error => {
  console.error(`[sha256-bench] failed: ${error?.stack || error}`);
  process.exit(1);
});
