/**
 * `yaac server stop` and `start` against locks and configs they did not
 * write. `stop` must not clear a live in-cluster server's lock, which would
 * let a second server open the same database (docs/server-in-cluster.md).
 * `start` must register the server in `server.json` and record its driver
 * in the data dir's `install.json`. Only the data dir and
 * the server socket are faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { newLeaseFields, readLock, writeLock } from '@yaac/shared/lock'
import { readInstallRecord, recordInstall } from '@yaac/shared/install-record'
import { readServerConfig, writeServerConfig } from '@yaac/shared/server-config'
import { LEASE_STALE_MS } from '@yaac/shared/server-lock-file'
import { startServer, stopServer } from '#main/lifecycle'

let tmpDir: string
let stderr: string[]

/** A lock written by a server in a pod: another host, and a live lease. */
async function podLock(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeLock({
    // pid 1 also exists on this host, so the pid proves nothing here.
    pid: 1,
    port: 8787,
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
    // Clearing it would make the pod exit and restart, and let a host
    // `yaac server start` open the same data dir. The CLI refuses a data
    // dir recorded as k8s before this; this one records no driver.
    await podLock()

    await stopServer()

    expect(await readLock()).not.toBeNull()
    expect(stderr.join('\n')).toMatch(/runs in a cluster/)
    // Names the fix and fails, rather than silently doing nothing.
    expect(stderr.join('\n')).toMatch(/yaac cluster stop[\s\S]*scale deployment\/yaac-server --replicas=0/)
    expect(process.exitCode).toBe(1)
  })

  it('clears an in-cluster lock whose lease went stale', async () => {
    // A pod's lock outlives a deleted Deployment; its lease shows it is dead.
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

  it('treats a lock naming THIS host as its own, whatever its lease says', async () => {
    // Judged by pid and /health; nothing answers on the port, so it is stale.
    await podLock({ pid: process.ppid, port: 1, host: os.hostname(), heartbeatAt: 0 })

    await stopServer()

    expect(await readLock()).toBeNull()
    expect(stderr.join('\n')).toMatch(/stale lock/)
  })
})

describe('startServer registration', () => {
  /** A stand-in server answering `/health`. */
  async function fakeServer() {
    const srv = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    return {
      port: (srv.address() as AddressInfo).port,
      close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    }
  }

  it('registers a server that was already running, instead of no-oping', async () => {
    // e.g. a foreground `yaac server run`, which registers nothing.
    vi.stubEnv('YAAC_BUILD_ID', 'test-build')
    const server = await fakeServer()
    try {
      await writeLock({
        pid: process.ppid,
        port: server.port,
        startedAt: Date.now(),
        buildId: 'test-build',
        ...newLeaseFields(),
      })

      await startServer()

      expect(stderr.join('\n')).toContain('already running')
      expect(await readServerConfig()).toEqual({
        url: `http://127.0.0.1:${server.port}`,
        enabled: true,
        saved: [{ url: `http://127.0.0.1:${server.port}` }],
      })
      expect(await readInstallRecord()).toEqual({ driver: 'containerless' })
    } finally {
      await server.close()
      vi.unstubAllEnvs()
    }
  })

  it('refuses to start on a k8s install rather than registering a second server', async () => {
    vi.stubEnv('YAAC_BUILD_ID', 'test-build')
    await recordInstall({ driver: 'k8s' })
    await writeServerConfig({ url: 'http://127.0.0.1:9999', enabled: true, saved: [] })
    await expect(startServer()).rejects.toThrow(/yaac cluster start/)
    // The refusal left the selection unchanged.
    expect(await readServerConfig()).toMatchObject({ url: 'http://127.0.0.1:9999' })
    vi.unstubAllEnvs()
  })
})
