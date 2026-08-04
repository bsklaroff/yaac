/**
 * The streaming process runner, driven against real short-lived processes:
 * its whole job is signals, pipes and process death, and a fake child cannot
 * tell you whether a grandchild survived a kill. Budgets are shrunk to
 * hundreds of milliseconds so the real thing stays fast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { runStreamingProcess } from '#platform/streaming-proc'

let dataDir: string

beforeEach(async () => {
  dataDir = await createTempDataDir()
})

afterEach(async () => {
  await cleanupTempDir(dataDir)
})

const base = { logPrefix: '[test] ', label: 'probe', timeoutMs: 30_000 }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runStreamingProcess', () => {
  it('streams a run to its logger and resolves on exit 0', async () => {
    const lines: string[] = []
    await runStreamingProcess('sh', ['-c', 'echo one; echo two >&2'], {
      ...base,
      onLog: (l) => lines.push(l),
      idleTimeoutMs: 10_000,
    })
    expect(lines.sort()).toEqual(['one', 'two'])
  })

  it('reports a nonzero exit with the output tail', async () => {
    await expect(runStreamingProcess('sh', ['-c', 'echo boom >&2; exit 3'], {
      ...base,
      tailLines: 5,
    })).rejects.toThrow('probe exited with code 3:\nboom')
  })

  it('kills a silent run, and only after it has gone quiet', async () => {
    // Output every 100ms for ~500ms — five times the idle budget in total
    // elapsed, and never killed for it; then silence, which is.
    const started = Date.now()
    await expect(runStreamingProcess('sh', [
      '-c', 'for i in 1 2 3 4 5; do echo tick; sleep 0.1; done; sleep 30',
    ], { ...base, idleTimeoutMs: 300, tailLines: 3 }))
      .rejects.toThrow(/probe produced no output for 300ms:\ntick/)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThan(500) // survived while it was talking
    expect(elapsed).toBeLessThan(3_000) // settled on death, not on the pipes
  })

  it('kills a run that is wedged but chatty, which no idle budget catches', async () => {
    const started = Date.now()
    await expect(runStreamingProcess('sh', [
      '-c', 'while true; do echo still here; sleep 0.05; done',
    ], { ...base, idleTimeoutMs: 60_000, timeoutMs: 400 }))
      .rejects.toThrow('probe still running after 400ms')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('takes the grandchildren with it, and settles without waiting for the pipes', async () => {
    // `sleep 300 &` inherits the stdio pipes, so `close` cannot arrive until
    // it dies — the hang this runner exists to avoid. Killing the process
    // group is what makes it die at all.
    let grandchild = 0
    const started = Date.now()
    await expect(runStreamingProcess('sh', [
      '-c', 'sleep 300 & echo $!; sleep 300',
    ], {
      ...base,
      idleTimeoutMs: 300,
      onLog: (l) => { grandchild = Number(l) },
    })).rejects.toThrow('probe produced no output for 300ms')
    expect(Date.now() - started).toBeLessThan(3_000)

    expect(grandchild).toBeGreaterThan(0)
    // The kill is asynchronous; give the group a moment to actually die.
    for (let i = 0; i < 40 && alive(grandchild); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(alive(grandchild)).toBe(false)
  })

  // The symmetric case to the kill path: the process ends on its own while a
  // grandchild holds the pipes. Its own exit status is the verdict, and a
  // held pipe may not postpone it — least of all into a timeout that never
  // happened, which would report a successful build as a failure.
  it('reports the exit status of a run whose grandchild holds the pipes open', async () => {
    const started = Date.now()
    await expect(runStreamingProcess('sh', ['-c', 'echo boom >&2; sleep 20 & exit 3'], {
      ...base,
      idleTimeoutMs: 1_000,
      tailLines: 3,
    })).rejects.toThrow('probe exited with code 3:\nboom')
    expect(Date.now() - started).toBeLessThan(5_000)

    const okStarted = Date.now()
    await runStreamingProcess('sh', ['-c', 'sleep 20 & exit 0'], { ...base, idleTimeoutMs: 1_000 })
    expect(Date.now() - okStarted).toBeLessThan(5_000)
  })

  it('rejects when the command cannot be spawned at all', async () => {
    await expect(runStreamingProcess('definitely-not-a-command', [], base))
      .rejects.toThrow(/ENOENT/)
  })

  it('hands the live child to onSpawn and reports death to onExit', async () => {
    const onExit = vi.fn()
    let pid = 0
    await runStreamingProcess('sh', ['-c', 'exit 0'], {
      ...base,
      onSpawn: (child) => { pid = child.pid ?? 0 },
      onExit,
    })
    expect(pid).toBeGreaterThan(0)
    expect(onExit).toHaveBeenCalled()
  })
})
