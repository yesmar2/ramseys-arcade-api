// Preloaded into the API under test (NODE_OPTIONS=--import): logs event-loop
// stalls, and records a CPU profile between two trigger files.
//   touch profile.start  -> profiler on
//   touch profile.stop   -> profiler off, writes cpu-<pid>.cpuprofile
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Only the API itself, not tsx's launcher process.
if (process.argv[1]?.endsWith('index.ts')) {
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  setInterval(() => {
    const max = delay.max / 1e6
    if (max > 200) {
      console.log(
        `[lag] ${new Date().toISOString().slice(11, 19)} max ${Math.round(max)} ms · p99 ${Math.round(delay.percentile(99) / 1e6)} ms · mean ${Math.round(delay.mean / 1e6)} ms · heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`,
      )
    }
    delay.reset()
  }, 2000).unref()

  // Single stalls, timed from a 50 ms tick that should never run late.
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    const late = now - last - 50
    if (late > 400) console.log(`[stall] ${Math.round(late)} ms at ${new Date().toISOString().slice(11, 23)}`)
    last = now
  }, 50).unref()

  const session = new Session()
  session.connect()
  const post = (method, params) =>
    new Promise((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))))
  let profiling = false
  setInterval(async () => {
    const start = join(HERE, 'profile.start')
    const stop = join(HERE, 'profile.stop')
    if (!profiling && existsSync(start)) {
      rmSync(start)
      profiling = true
      await post('Profiler.enable')
      await post('Profiler.setSamplingInterval', { interval: 500 })
      await post('Profiler.start')
      console.log('[profile] started')
    } else if (profiling && existsSync(stop)) {
      rmSync(stop)
      profiling = false
      const { profile } = await post('Profiler.stop')
      const out = join(HERE, `cpu-${process.pid}.cpuprofile`)
      writeFileSync(out, JSON.stringify(profile))
      console.log(`[profile] written ${out}`)
    }
  }, 500).unref()
}
