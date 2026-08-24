/**
 * `yaac server stop` against a lock it did not write.
 *
 * The in-cluster server's lock crosses a container boundary
 * (docs/server-in-cluster.md), and what this command does with one is the
 * difference between stopping a server and manufacturing the dual-writer
 * the whole lease design exists to prevent. Nothing is mocked but the data
 * dir: the lock is a real file and the judgment runs for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { readLock, writeLock } from '@yaac/shared/lock'
import { LEASE_STALE_MS } from '@yaac/shared/server-lock-file'
import { stopServer } from '#main/lifecycle'

let tmpDir: string
let stderr: string[]

/** A lock written by a server in a pod: another host, and a live lease. */
async function podLock(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeLock({
    // pid 1 is what a pod's init is, and a number this host also has —
    // which is the whole reason a cross-boundary lock cannot be judged by
    // its pid.
    pid: 1,
    port: 8787,
    secret: 's',
    startedAt: Date.now(),
    buildId: 'b',
    instance: 'inst-1',
    host: 'yaac-server-77d4f',
    heartbeatAt: Date.now(),
    ...overrides,
  })
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  stderr = []
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
    stderr.push(String(msg))
  })
  process.exitCode = undefined
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  await cleanupTempDir(tmpDir)
})

describe('stopServer', () => {
  it('refuses a live in-cluster server rather than clearing its lock', async () => {
    // Removing it would be the worst answer available: the pod loses its
    // lease at the next tick and exits, the Deployment restarts it — a
    // stop that produced a restart — and a `yaac server start` in the same
    // state would then spawn a host process onto a data dir whose lock
    // this command had just cleared. Reaching here at all means the
    // Deployment path could not run (the cluster was unreachable), so the
    // only correct action is none.
    await podLock()

    await stopServer()

    expect(await readLock()).not.toBeNull()
    expect(stderr.join('\n')).toMatch(/runs in the cluster/)
    // Names the fix, and fails: a stop that silently did nothing would be
    // read as a stop that worked.
    expect(stderr.join('\n')).toMatch(/scale deployment\/yaac-server --replicas=0/)
    expect(process.exitCode).toBe(1)
  })

  it('clears an in-cluster lock whose lease went stale', async () => {
    // The leftover of a server that is really gone — a pod's lock outlives
    // a deleted Deployment, and nothing else would ever collect it. Judged
    // by the lease, because the pid and port name another namespace's.
    await podLock({ heartbeatAt: Date.now() - LEASE_STALE_MS * 2 })

    await stopServer()

    expect(await readLock()).toBeNull()
    expect(stderr.join('\n')).toMatch(/stale lock/)
    expect(process.exitCode).toBeUndefined()
  })

  it('says so when there is nothing running', async () => {
    await stopServer()
    expect(stderr.join('\n')).toMatch(/not running/)
    expect(process.exitCode).toBeUndefined()
  })

  it('treats a lock naming THIS host as its own, lease or not', async () => {
    // The host path still judges by pid and /health, so a lock this
    // machine wrote is signalled rather than refused. Nothing answers on
    // the port, so it reads as stale and is cleared.
    await podLock({ pid: process.pid, port: 1, host: os.hostname(), heartbeatAt: undefined })

    await stopServer()

    expect(await readLock()).toBeNull()
    expect(stderr.join('\n')).toMatch(/stale lock/)
  })
})
