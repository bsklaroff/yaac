/**
 * The `yaac server` lifecycle verbs against locks and configs they did not
 * write.
 *
 * `stop`: the in-cluster server's lock crosses a container boundary
 * (docs/server-in-cluster.md), and what this command does with one is the
 * difference between stopping a server and manufacturing the dual-writer
 * the whole lease design exists to prevent.
 *
 * `start`: it is the command that REGISTERS a host server, so what it
 * writes into `server.json` is the whole of "clients on this machine can
 * reach it". Nothing is mocked but the data dir and the server socket: the
 * lock is a real file, the mint is a real request, and the judgment runs
 * for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { readLock, writeLock } from '@yaac/shared/lock'
import { readServerConfig, writeServerConfig } from '@yaac/shared/server-config'
import { LEASE_STALE_MS } from '@yaac/shared/server-lock-file'
import { startServer, stopServer } from '#main/lifecycle'

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

describe('startServer registration', () => {
  /**
   * A stand-in for the running server: `/health` for the liveness probe,
   * and the `/tokens` pair the durable-token mint uses.
   */
  async function fakeServer(opts: { minted?: string | null } = {}) {
    const requests: string[] = []
    const srv = http.createServer((req, res) => {
      requests.push(`${req.method ?? ''} ${req.url ?? ''}`)
      res.setHeader('content-type', 'application/json')
      if (req.url === '/tokens' && req.method === 'POST') {
        if (opts.minted === null) {
          res.statusCode = 500
          res.end('{}')
          return
        }
        res.end(JSON.stringify({ token: opts.minted ?? 'minted-token' }))
        return
      }
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    return {
      port: (srv.address() as AddressInfo).port,
      requests,
      close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    }
  }

  it('registers a server that was already running, instead of no-oping', async () => {
    // "Already running" includes a server the operator started in the
    // foreground with `yaac server run`, which registers nothing. Without
    // this, start would print success against a server no client can reach.
    vi.stubEnv('YAAC_BUILD_ID', 'test-build')
    const server = await fakeServer()
    try {
      await writeLock({
        pid: process.pid,
        port: server.port,
        secret: 'lock-secret',
        startedAt: Date.now(),
        buildId: 'test-build',
      })

      await startServer()

      expect(stderr.join('\n')).toContain('already running')
      expect(await readServerConfig()).toMatchObject({
        url: `http://127.0.0.1:${server.port}`,
        token: 'minted-token',
        enabled: true,
        driver: 'containerless',
      })
      // Revoke-then-create, and under the lock secret — the only credential
      // that authenticates as the server itself.
      expect(server.requests).toContain('DELETE /tokens/local-client')
      expect(server.requests).toContain('POST /tokens')
    } finally {
      await server.close()
      vi.unstubAllEnvs()
    }
  })

  it('leaves the server up, and says so, when the mint fails', async () => {
    // The server is fine; only this machine's pointer at it is missing, and
    // the recovery is to run the command again.
    vi.stubEnv('YAAC_BUILD_ID', 'test-build')
    const server = await fakeServer({ minted: null })
    try {
      await writeLock({
        pid: process.pid,
        port: server.port,
        secret: 'lock-secret',
        startedAt: Date.now(),
        buildId: 'test-build',
      })

      await startServer()

      // An empty token is written rather than nothing: a credential-optional
      // install needs none, and refusing to write would point the machine at
      // no server at all.
      expect(await readServerConfig()).toMatchObject({
        url: `http://127.0.0.1:${server.port}`,
        token: '',
        driver: 'containerless',
      })
    } finally {
      await server.close()
      vi.unstubAllEnvs()
    }
  })

  it('refuses to start on a k8s install rather than registering a second server', async () => {
    vi.stubEnv('YAAC_BUILD_ID', 'test-build')
    await writeServerConfig({
      url: 'http://127.0.0.1:9999', token: 't', enabled: true, saved: [], driver: 'k8s',
    })
    await expect(startServer()).rejects.toThrow(/yaac cluster install/)
    // And the refusal did not rewrite the selection on its way out.
    expect(await readServerConfig()).toMatchObject({ url: 'http://127.0.0.1:9999' })
    vi.unstubAllEnvs()
  })
})
