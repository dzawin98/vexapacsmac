export function createJobQueue(options = {}) {
  const name = String(options.name || 'runtime-jobs')
  const concurrency = Math.max(1, Number(options.concurrency || 2))
  const defaultAttempts = Math.max(1, Number(options.defaultAttempts || 2))
  const handlers = new Map()
  const pending = []
  const running = new Map()
  const completed = []
  const failed = []
  let sequence = 0
  let processing = false

  function register(type, handler) {
    if (typeof handler !== 'function') {
      throw new Error(`Job handler for ${type} must be a function`)
    }
    handlers.set(String(type), handler)
  }

  function add(type, data = {}, jobOptions = {}) {
    const id = `${name}-${Date.now()}-${++sequence}`
    const job = {
      id,
      type: String(type),
      data,
      attempts: Math.max(1, Number(jobOptions.attempts || defaultAttempts)),
      attemptsMade: 0,
      delayMs: Math.max(0, Number(jobOptions.delayMs || 0)),
      createdAt: Date.now(),
      runAt: Date.now() + Math.max(0, Number(jobOptions.delayMs || 0)),
    }
    pending.push(job)
    processSoon()
    return id
  }

  function stats() {
    return {
      name,
      backend: 'memory',
      pending: pending.length,
      running: running.size,
      completed: completed.length,
      failed: failed.length,
      handlers: [...handlers.keys()],
      concurrency,
    }
  }

  async function drain(timeoutMs = 30000) {
    const startedAt = Date.now()
    while ((pending.length || running.size) && Date.now() - startedAt < timeoutMs) {
      await sleep(25)
    }
    return stats()
  }

  function processSoon() {
    if (processing) return
    processing = true
    queueMicrotask(async () => {
      try {
        await processLoop()
      } finally {
        processing = false
        if (pending.some((job) => job.runAt <= Date.now()) && running.size < concurrency) {
          processSoon()
        }
      }
    })
  }

  async function processLoop() {
    while (running.size < concurrency) {
      const index = pending.findIndex((job) => job.runAt <= Date.now())
      if (index < 0) {
        const nextRunAt = Math.min(...pending.map((job) => job.runAt).filter(Number.isFinite))
        if (Number.isFinite(nextRunAt)) {
          setTimeout(processSoon, Math.max(0, nextRunAt - Date.now())).unref?.()
        }
        return
      }

      const [job] = pending.splice(index, 1)
      running.set(job.id, job)
      void runJob(job)
    }
  }

  async function runJob(job) {
    const handler = handlers.get(job.type)
    try {
      if (!handler) {
        throw new Error(`No handler registered for job type ${job.type}`)
      }
      job.attemptsMade += 1
      const result = await handler(job)
      completed.push({ id: job.id, type: job.type, completedAt: Date.now(), result })
      trim(completed)
    } catch (error) {
      if (job.attemptsMade < job.attempts) {
        job.runAt = Date.now() + Math.min(30000, 500 * 2 ** job.attemptsMade)
        pending.push(job)
      } else {
        failed.push({
          id: job.id,
          type: job.type,
          failedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        })
        trim(failed)
      }
    } finally {
      running.delete(job.id)
      processSoon()
    }
  }

  function trim(list) {
    const maxHistory = Math.max(10, Number(options.maxHistory || 200))
    while (list.length > maxHistory) list.shift()
  }

  return { register, add, stats, drain }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
