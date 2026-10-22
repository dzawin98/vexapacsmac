import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { LoggerSingleton } from '../utils/logger';

/**
 * Persistent JPEG 2000 / HTJ2K decoder pool.
 *
 * Latar belakang (terukur): decode satu frame memakai `python -c` sekali pakai
 * membuang ~200-300 ms hanya untuk start interpreter + import openjpeg/imagecodecs.
 * Dengan retensi cache 14 hari, sebagian besar studi dibuka pertama kali oleh
 * pengguna sehingga frame-nya harus di-decode "dingin" - biaya spawn itu terasa
 * langsung di layar. Pool ini menjaga proses decoder tetap hidup dan memakai
 * protokol panjang-prefix biner, jadi biaya start dibayar sekali saja.
 *
 * Keamanan perilaku: bila pool tidak bisa dipakai (gagal start, proses mati,
 * timeout, atau dimatikan lewat env), fungsi ini mengembalikan null sehingga
 * pemanggil memakai jalur lama `spawn python -c` - jadi dekode selalu punya
 * jalur cadangan dan tidak pernah "hilang".
 */

const KINDS = { j2k: 0x6a, htj2k: 0x68 } as const; // 'j' dan 'h'
const ERROR_LENGTH = 0xffffffff;

export type J2kKind = 'j2k' | 'htj2k';

const workerScript = [
  'import sys, struct',
  // Import the decoders once at start, not inside the first request: a worker that is
  // spawned ahead of time (startup warm) must be ready to decode, otherwise the first
  // study still pays the import on its critical path.
  'try:',
  '    import openjpeg',
  'except Exception:',
  '    openjpeg = None',
  'try:',
  '    import imagecodecs',
  'except Exception:',
  '    imagecodecs = None',
  'stdin = sys.stdin.buffer',
  'stdout = sys.stdout.buffer',
  'def write(payload):',
  '    stdout.write(struct.pack(">I", len(payload)))',
  '    stdout.write(payload)',
  '    stdout.flush()',
  'while True:',
  '    head = stdin.read(5)',
  '    if not head or len(head) < 5:',
  '        break',
  '    kind = head[0:1]',
  '    size = struct.unpack(">I", head[1:5])[0]',
  '    data = stdin.read(size) if size else b""',
  '    try:',
  '        if kind == b"h":',
  '            if imagecodecs is None:',
  '                raise RuntimeError("imagecodecs tidak tersedia untuk worker ini")',
  '            arr = imagecodecs.htj2k_decode(data)',
  '        else:',
  '            if openjpeg is None:',
  '                raise RuntimeError("openjpeg tidak tersedia untuk worker ini")',
  '            arr = openjpeg.decode(data, j2k_format=0)',
  '        write(arr.tobytes(order="C"))',
  '    except Exception as exc:',
  '        message = repr(exc).encode("utf-8", "replace")[:400]',
  '        stdout.write(struct.pack(">I", 0xFFFFFFFF))',
  '        stdout.write(struct.pack(">I", len(message)))',
  '        stdout.write(message)',
  '        stdout.flush()',
].join('\n');

interface PoolWorker {
  proc: ChildProcessWithoutNullStreams;
  buffer: Buffer;
  busy: boolean;
  requests: number;
  idleTimer: NodeJS.Timeout | null;
  task: PoolTask | null;
}

interface PoolTask {
  kind: J2kKind;
  payload: Buffer;
  resolve: (value: Buffer) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  enqueuedAt: number;
}

const counters = {
  starts: 0,
  exits: 0,
  idleKills: 0,
  requests: 0,
  errors: 0,
  timeouts: 0,
  unavailable: 0,
  totalMs: 0,
  lastMs: 0,
  lastError: null as string | null,
};

let workers: PoolWorker[] = [];
const queue: PoolTask[] = [];
let disabled = false;
let consecutiveStartFailures = 0;

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  return fallback;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

export function j2kWorkerPoolEnabled(): boolean {
  return !disabled && envFlag('DICOMWEB_J2K_PERSISTENT', true);
}

function poolSize(): number {
  return envInt('DICOMWEB_J2K_WORKERS', 4, 1, 8);
}

function idleMs(): number {
  // 30 min by default: retiring the workers is cheap for the machine but expensive for
  // the next study, which then pays a python+openjpeg start (~50-70 ms per frame until
  // the pool is back). A quiet ward between patients must not cost the radiologist time.
  return envInt('DICOMWEB_J2K_IDLE_MS', 1_800_000, 5_000, 3_600_000);
}

function requestTimeoutMs(): number {
  return envInt('DICOMWEB_J2K_TIMEOUT_MS', 30_000, 1_000, 180_000);
}

function clearIdleTimer(worker: PoolWorker) {
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
  }
}

function retireWorker(worker: PoolWorker, reason: string) {
  clearIdleTimer(worker);
  workers = workers.filter((candidate) => candidate !== worker);
  if (!worker.proc.killed) {
    try {
      worker.proc.kill();
    } catch {
      /* proses sudah mati */
    }
  }
  if (worker.task) {
    const task = worker.task;
    worker.task = null;
    clearTimeout(task.timeout);
    task.reject(new Error(`decoder worker berhenti (${reason})`));
  }
}

function handleChunk(worker: PoolWorker, chunk: Buffer) {
  worker.buffer = worker.buffer.length ? Buffer.concat([worker.buffer, chunk]) : chunk;
  while (worker.buffer.length >= 4) {
    const length = worker.buffer.readUInt32BE(0);
    if (length === ERROR_LENGTH) {
      if (worker.buffer.length < 8) return;
      const messageLength = worker.buffer.readUInt32BE(4);
      if (worker.buffer.length < 8 + messageLength) return;
      const message = worker.buffer.subarray(8, 8 + messageLength).toString('utf8');
      worker.buffer = worker.buffer.subarray(8 + messageLength);
      failTask(worker, new Error(message || 'decoder error tanpa pesan'));
      continue;
    }
    if (worker.buffer.length < 4 + length) return;
    const payload = worker.buffer.subarray(4, 4 + length);
    worker.buffer = worker.buffer.subarray(4 + length);
    completeTask(worker, Buffer.from(payload));
  }
}

function completeTask(worker: PoolWorker, payload: Buffer) {
  const task = worker.task;
  worker.task = null;
  worker.busy = false;
  if (task) {
    clearTimeout(task.timeout);
    counters.lastMs = Date.now() - task.enqueuedAt;
    counters.totalMs += counters.lastMs;
    task.resolve(payload);
  }
  scheduleIdle(worker);
  drainQueue();
}

function failTask(worker: PoolWorker, error: Error) {
  const task = worker.task;
  worker.task = null;
  worker.busy = false;
  counters.errors += 1;
  counters.lastError = error.message.slice(0, 300);
  if (task) {
    clearTimeout(task.timeout);
    task.reject(error);
  }
  scheduleIdle(worker);
  drainQueue();
}

function scheduleIdle(worker: PoolWorker) {
  clearIdleTimer(worker);
  if (worker.busy || worker.task) return;
  worker.idleTimer = setTimeout(() => {
    if (worker.busy || worker.task) return;
    counters.idleKills += 1;
    workers = workers.filter((candidate) => candidate !== worker);
    try {
      worker.proc.kill();
    } catch {
      /* sudah mati */
    }
  }, idleMs());
  if (typeof worker.idleTimer.unref === 'function') worker.idleTimer.unref();
}

function startWorker(pythonPath: string): PoolWorker | null {
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(pythonPath, ['-u', '-c', workerScript], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    consecutiveStartFailures += 1;
    counters.lastError = `gagal spawn decoder worker: ${(error as Error).message}`;
    return null;
  }

  const worker: PoolWorker = { proc, buffer: Buffer.alloc(0), busy: false, requests: 0, idleTimer: null, task: null };

  proc.stdout.on('data', (chunk: Buffer) => handleChunk(worker, chunk));
  proc.stderr.on('data', (chunk: Buffer) => {
    counters.lastError = chunk.toString('utf8').slice(0, 300);
    LoggerSingleton.Instance.debug(`decoder worker stderr: ${counters.lastError}`);
  });
  proc.stdin.on('error', (error: Error) => {
    counters.lastError = error.message;
    LoggerSingleton.Instance.debug(`decoder worker stdin error (diabaikan): ${error.message}`);
  });
  proc.on('error', (error: Error) => {
    consecutiveStartFailures += 1;
    counters.errors += 1;
    counters.lastError = error.message.slice(0, 300);
    LoggerSingleton.Instance.warn(`decoder worker error: ${error.message}`);
    retireWorker(worker, 'error');
    drainQueue();
  });
  proc.on('exit', (code, signal) => {
    counters.exits += 1;
    const unexpected = Boolean(worker.task);
    retireWorker(worker, `exit ${code ?? signal}`);
    if (unexpected) {
      consecutiveStartFailures += 1;
      counters.errors += 1;
      LoggerSingleton.Instance.warn(`decoder worker berhenti saat melayani frame (code=${code}); permintaan akan dicoba lewat jalur spawn biasa`);
    }
    drainQueue();
  });

  counters.starts += 1;
  consecutiveStartFailures = 0;
  workers.push(worker);
  scheduleIdle(worker);
  return worker;
}

function idleWorker(): PoolWorker | null {
  return workers.find((worker) => !worker.busy && !worker.task) ?? null;
}

function drainQueue() {
  while (queue.length) {
    const worker = idleWorker() ?? (workers.length < poolSize() ? startWorker(lastPython) : null);
    if (!worker) return;
    const task = queue.shift() as PoolTask;
    dispatch(worker, task);
  }
}

let lastPython = 'python';

function dispatch(worker: PoolWorker, task: PoolTask) {
  clearIdleTimer(worker);
  worker.busy = true;
  worker.task = task;
  worker.requests += 1;
  counters.requests += 1;
  task.enqueuedAt = Date.now();
  task.timeout = setTimeout(() => {
    counters.timeouts += 1;
    counters.lastError = 'decoder worker timeout';
    retireWorker(worker, 'timeout');
    task.reject(new Error('decoder worker timeout'));
    drainQueue();
  }, requestTimeoutMs());
  try {
    const header = Buffer.alloc(5);
    header.writeUInt8(KINDS[task.kind], 0);
    header.writeUInt32BE(task.payload.length, 1);
    worker.proc.stdin.write(Buffer.concat([header, task.payload]));
  } catch (error) {
    clearTimeout(task.timeout);
    worker.busy = false;
    worker.task = null;
    counters.errors += 1;
    counters.lastError = (error as Error).message.slice(0, 300);
    task.reject(new Error(`gagal menulis ke decoder worker: ${(error as Error).message}`));
    retireWorker(worker, 'write error');
  }
}

/**
 * Decode satu frame lewat worker persisten.
 * - Mengembalikan Buffer hasil dekode bila berhasil.
 * - Mengembalikan null bila pool tidak tersedia (pemanggil harus memakai jalur spawn biasa).
 * - Melempar error bila worker melaporkan kegagalan dekode (frame memang tidak bisa dibaca).
 */
export async function decodeJ2kViaPool(kind: J2kKind, payload: Buffer, pythonPath: string): Promise<Buffer | null> {
  if (!j2kWorkerPoolEnabled()) {
    counters.unavailable += 1;
    return null;
  }

  lastPython = pythonPath;
  const worker = idleWorker() ?? (workers.length < poolSize() ? startWorker(pythonPath) : null);
  if (!worker) {
    if (queue.length >= 64) {
      counters.unavailable += 1;
      return null;
    }
    return new Promise<Buffer | null>((resolve, reject) => {
      queue.push({
        kind,
        payload,
        resolve: (value: Buffer) => resolve(value),
        reject,
        timeout: null as unknown as NodeJS.Timeout,
        enqueuedAt: Date.now(),
      });
    });
  }

  return new Promise<Buffer | null>((resolve, reject) => {
    dispatch(worker, {
      kind,
      payload,
      resolve: (value: Buffer) => resolve(value),
      reject,
      timeout: null as unknown as NodeJS.Timeout,
      enqueuedAt: Date.now(),
    });
  });
}

/**
 * Start the decoder workers before the first frame arrives.
 *
 * Spawning is otherwise lazy: the first study after a start (or after the workers were
 * retired) pays a python+openjpeg start per worker, measured 779 ms/frame for the first
 * burst versus 14 ms with a single warm worker. Warm 1 by default; `count` is capped by
 * DICOMWEB_J2K_WORKERS. Returns the number of live workers.
 */
export function warmJ2kWorkerPool(pythonPath: string, count = 1): number {
  if (!j2kWorkerPoolEnabled()) {
    return 0;
  }
  lastPython = pythonPath;
  const target = Math.min(poolSize(), Math.max(1, Math.floor(count)));
  while (workers.length < target) {
    const started = startWorker(pythonPath);
    if (!started) {
      break;
    }
  }
  if (workers.length) {
    LoggerSingleton.Instance.info(`decoder pool warm: ${workers.length} worker siap (idle ${Math.round(idleMs() / 1000)} s)`);
  }
  return workers.length;
}

export function getJ2kWorkerPoolStats() {
  return {
    enabled: j2kWorkerPoolEnabled(),
    disabled,
    poolSize: poolSize(),
    workers: workers.length,
    busy: workers.filter((worker) => worker.busy || worker.task).length,
    queued: queue.length,
    starts: counters.starts,
    exits: counters.exits,
    idleKills: counters.idleKills,
    requests: counters.requests,
    errors: counters.errors,
    timeouts: counters.timeouts,
    unavailable: counters.unavailable,
    avgMs: counters.requests ? Math.round(counters.totalMs / counters.requests) : 0,
    lastMs: counters.lastMs,
    lastError: counters.lastError,
  };
}

export function shutdownJ2kWorkers() {
  for (const worker of [...workers]) retireWorker(worker, 'shutdown');
  queue.splice(0, queue.length).forEach((task) => task.reject(new Error('decoder pool shutdown')));
}

process.on('exit', () => {
  shutdownJ2kWorkers();
});
