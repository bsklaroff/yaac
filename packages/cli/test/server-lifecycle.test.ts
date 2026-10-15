/**
 * `yaac server stop`, `start`, `status` and `logs`, and `yaac cluster
 * status`, against locks, configs and logs they did not write. `stop` must
 * not clear a live in-cluster server's lock, which would let a second
 * server open the same database (docs/server-in-cluster.md). `start` must
 * register the server in `server.json` and record its driver in the data
 * dir's `install.json`. `status` must not call a server that refused to
 * start, or one that hangs, `running`. Only the data dir and the server
 * socket are faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { newLeaseFields, readLock, writeLock } from '@yaac/shared/lock'
import { readInstallRecord, recordInstall } from '@yaac/shared/install-record'
import { readServerConfig, writeServerConfig } from '@yaac/shared/server-config'
import { LEASE_STALE_MS } from '@yaac/shared/server-lock-file'
import { serverLogPath } from '@yaac/shared/paths'
import { clusterStatus, serverLogs, serverStart, serverStatus, serverStop } from '#commands/server-lifecycle'

let tmpDir: string
let stderr: string[]
let stdoutWrite: MockInstance<typeof process.stdout.write>

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

/** A stand-in server answering `/health` with `body`. */
async function fakeServer(body: object = { ok: true }) {
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  return {
    port: (srv.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  }
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  vi.stubEnv('YAAC_BUILD_ID', 'test-build')
  stderr = []
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
    stderr.push(String(msg))
  })
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  process.exitCode = undefined
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = undefined
  await cleanupTempDir(tmpDir)
})

describe('serverStop', () => {
  it('refuses a live in-cluster server rather than clearing its lock', async () => {
    // Clearing it would make the pod exit and restart, and let a host
    // `yaac server start` open the same data dir. The CLI refuses a data
    // dir recorded as k8s before this; this one records no driver.
    await podLock()

    await serverStop()

    expect(await readLock()).not.toBeNull()
    expect(stderr.join('\n')).toMatch(/runs in a cluster/)
    // Names the fix and fails, rather than silently doing nothing.
    expect(stderr.join('\n')).toMatch(/yaac cluster stop[\s\S]*scale deployment\/yaac-server --replicas=0/)
    expect(process.exitCode).toBe(1)
  })

  it('clears an in-cluster lock whose lease went stale', async () => {
    // A pod's lock outlives a deleted Deployment; its lease shows it is dead.
    await podLock({ heartbeatAt: Date.now() - LEASE_STALE_MS * 2 })

    await serverStop()

    expect(await readLock()).toBeNull()
    expect(stderr.join('\n')).toMatch(/stale lock/)
    expect(process.exitCode).toBeUndefined()
  })

  it('says so when there is nothing running', async () => {
    await serverStop()
    expect(stderr.join('\n')).toMatch(/not running/)
    expect(process.exitCode).toBeUndefined()
  })

  it('treats a lock naming THIS host as its own, whatever its lease says', async () => {
    // Judged by pid and /health; nothing answers on the port, so it is stale.
    await podLock({ pid: process.ppid, port: 1, host: os.hostname(), heartbeatAt: 0 })

    await serverStop()

    expect(await readLock()).toBeNull()
    expect(stderr.join('\n')).toMatch(/stale lock/)
  })
})

describe('serverStart', () => {
  it('registers a server that was already running, instead of no-oping', async () => {
    // e.g. a foreground `yaac server run`, which registers nothing.
    const server = await fakeServer()
    try {
      await writeLock({
        pid: process.ppid,
        port: server.port,
        startedAt: Date.now(),
        buildId: 'test-build',
        ...newLeaseFields(),
      })

      await serverStart()

      expect(stderr.join('\n')).toContain('already running')
      expect(await readServerConfig()).toEqual({
        url: `http://127.0.0.1:${server.port}`,
        saved: [{ url: `http://127.0.0.1:${server.port}` }],
      })
      expect(await readInstallRecord()).toEqual({ driver: 'containerless', origin: `http://127.0.0.1:${server.port}` })
    } finally {
      await server.close()
    }
  })

  it('refuses to start on a k8s install rather than registering a second server', async () => {
    await recordInstall({ driver: 'k8s' })
    await writeServerConfig({ url: 'http://127.0.0.1:9999', saved: [] })
    await expect(serverStart()).rejects.toThrow(/yaac cluster start/)
    // The refusal left the selection unchanged.
    expect(await readServerConfig()).toMatchObject({ url: 'http://127.0.0.1:9999' })
  })
})

const REFUSED = { ok: true, ready: false, refused: 'secret.key is missing' }

/** What a status command printed, one entry per `console.log`. */
async function printed(run: () => Promise<void>): Promise<string[]> {
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { out.push(String(msg)) })
  await run()
  return out
}

describe('serverStatus', () => {
  it('reports a host server that refused to start, not `running`', async () => {
    const server = await fakeServer(REFUSED)
    try {
      await writeLock({ pid: process.ppid, port: server.port, startedAt: Date.now(), buildId: 'test-build', ...newLeaseFields() })

      expect(await printed(() => serverStatus({}))).toEqual(['up, but refused to start: secret.key is missing'])
      const [json] = await printed(() => serverStatus({ json: true }))
      expect(JSON.parse(json)).toMatchObject({
        running: true, serverBuildId: 'test-build', refused: 'secret.key is missing', reachable: true,
      })
    } finally {
      await server.close()
    }
  })

  it('reports a host server whose pid lives but whose port is silent as running and unreachable', async () => {
    // A hung server (stopped, or blocked in a migration), not a stopped one.
    await writeLock({ pid: process.ppid, port: 1, startedAt: Date.now(), buildId: 'test-build', ...newLeaseFields() })

    expect(await printed(() => serverStatus({})))
      .toEqual(['running, but its /api/health does not answer; see `yaac server logs`'])
    const [json] = await printed(() => serverStatus({ json: true }))
    expect(JSON.parse(json)).toMatchObject({ running: true, refused: null, reachable: false })
  })

  it('asks nothing for another host\'s lock on a data dir with no cluster origin', async () => {
    // The host server's origin would be another server than the lock's.
    await recordInstall({ driver: 'containerless', origin: 'http://127.0.0.1:1' })
    await podLock({ buildId: 'test-build' })

    expect(await printed(() => serverStatus({}))).toEqual(['running'])
    const [json] = await printed(() => serverStatus({ json: true }))
    expect(JSON.parse(json)).toMatchObject({ running: true, refused: null, reachable: null })
  })
})

describe('clusterStatus', () => {
  it('asks the pod\'s server at the install\'s origin, since its lock names a port inside the pod', async () => {
    const server = await fakeServer(REFUSED)
    try {
      await recordInstall({ driver: 'k8s', origin: `http://127.0.0.1:${server.port}` })
      await podLock()

      expect(await printed(() => clusterStatus({}))).toEqual(['up, but refused to start: secret.key is missing'])
      const [json] = await printed(() => clusterStatus({ json: true }))
      expect(JSON.parse(json)).toMatchObject({ running: true, driver: 'k8s', refused: 'secret.key is missing', reachable: true })
    } finally {
      await server.close()
    }
  })

  it('tells a live lease whose server does not answer apart from a refusal', async () => {
    // A port nothing listens on: the origin's port mapping is gone, say.
    const server = await fakeServer()
    await server.close()
    await recordInstall({ driver: 'k8s', origin: `http://127.0.0.1:${server.port}` })
    await podLock()

    expect(await printed(() => clusterStatus({})))
      .toEqual(['running, but its /api/health does not answer; see `yaac cluster logs`'])
    const [json] = await printed(() => clusterStatus({ json: true }))
    expect(JSON.parse(json)).toMatchObject({ running: true, refused: null, reachable: false })
  })
})

describe('serverLogs', () => {
  beforeEach(async () => {
    await fs.mkdir(path.dirname(serverLogPath()), { recursive: true })
  })

  function stdoutContent(): string {
    return stdoutWrite.mock.calls
      .map((args) => {
        const chunk = args[0]
        if (typeof chunk === 'string') return chunk
        if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
        return ''
      })
      .join('')
  }

  it('prints a notice to stderr when the log file is missing', async () => {
    await serverLogs()
    expect(stderr.join('\n')).toContain('no server log at')
    expect(stdoutContent()).toBe('')
  })

  it('prints the whole log file when no options are given', async () => {
    await fs.writeFile(serverLogPath(), 'alpha\nbeta\ngamma\n')
    await serverLogs()
    expect(stdoutContent()).toBe('alpha\nbeta\ngamma\n')
  })

  it('prints only the last N lines when --lines is set', async () => {
    await fs.writeFile(serverLogPath(), 'one\ntwo\nthree\nfour\nfive\n')
    await serverLogs({ lines: 2 })
    expect(stdoutContent()).toBe('four\nfive\n')
  })

  it('lines=0 prints nothing but does not error', async () => {
    await fs.writeFile(serverLogPath(), 'a\nb\n')
    await serverLogs({ lines: 0 })
    expect(stdoutContent()).toBe('')
  })

  it('lines larger than file prints the whole file', async () => {
    await fs.writeFile(serverLogPath(), 'a\nb\n')
    await serverLogs({ lines: 100 })
    expect(stdoutContent()).toBe('a\nb\n')
  })

  it('handles a final line without a trailing newline', async () => {
    await fs.writeFile(serverLogPath(), 'a\nb\nc')
    await serverLogs({ lines: 2 })
    expect(stdoutContent()).toBe('b\nc')
  })
})
