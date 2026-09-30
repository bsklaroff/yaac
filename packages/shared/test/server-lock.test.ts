import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  acquireLock,
  newLeaseFields,
  renewLease,
  serverLockPath,
  readLock,
  writeLock,
  removeLock,
} from '#lock'
import {
  LEASE_HEARTBEAT_MS,
  LEASE_STALE_MS,
  isLeaseFresh,
  isLockLive,
  isLockReady,
  isSameHostLock,
  isServerLock,
  parseServerLock,
  type ServerLock,
} from '#server-lock-file'

/** A lease written on this host, for locks that are not about the lease. */
const LEASE = { instance: 'i', host: os.hostname(), heartbeatAt: Date.now() }

describe('server lock', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('readLock', () => {
    it('returns null when the lock is missing', async () => {
      expect(await readLock()).toBeNull()
    })

    it('returns null on malformed JSON', async () => {
      await fs.writeFile(serverLockPath(), 'not json')
      expect(await readLock()).toBeNull()
    })

    it('returns null when required fields are missing', async () => {
      await fs.writeFile(serverLockPath(), JSON.stringify({ pid: 123 }))
      expect(await readLock()).toBeNull()
    })

    it('returns the parsed lock when valid', async () => {
      const lock: ServerLock = { pid: 1, port: 2, startedAt: 3, buildId: 'b', ...LEASE }
      await fs.writeFile(serverLockPath(), JSON.stringify(lock))
      expect(await readLock()).toEqual(lock)
    })
  })

  describe('writeLock', () => {
    it('writes the lock with mode 0600', async () => {
      const lock: ServerLock = { pid: 1, port: 2, startedAt: 3, buildId: 'b', ...LEASE }
      await writeLock(lock)
      const stat = await fs.stat(serverLockPath())
      // Bottom 9 bits of mode are the rwxrwxrwx triplet.
      expect(stat.mode & 0o777).toBe(0o600)
      expect(JSON.parse(await fs.readFile(serverLockPath(), 'utf8'))).toEqual(lock)
    })

    it('overwrites an existing lock atomically', async () => {
      await writeLock({ pid: 1, port: 2, startedAt: 3, buildId: 'b1', ...LEASE })
      await writeLock({ pid: 9, port: 8, startedAt: 7, buildId: 'b2', ...LEASE })
      expect(await readLock()).toEqual({ pid: 9, port: 8, startedAt: 7, buildId: 'b2', ...LEASE })
    })
  })

  describe('removeLock', () => {
    it('unlinks the lock', async () => {
      await writeLock({ pid: 1, port: 2, startedAt: 3, buildId: 'b', ...LEASE })
      await removeLock()
      expect(await readLock()).toBeNull()
    })

    it('is a no-op when the lock is missing', async () => {
      await expect(removeLock()).resolves.toBeUndefined()
    })

    it('unlinks when the expected holder matches', async () => {
      const lock: ServerLock = { pid: 42, port: 2, startedAt: 3, buildId: 'b', ...LEASE }
      await writeLock(lock)
      await removeLock(LEASE.instance)
      expect(await readLock()).toBeNull()
    })

    it('leaves the lock alone when the expected holder does not match', async () => {
      // Two server pods can both be pid 1, so ownership is by instance: a
      // successor's lock survives its predecessor's late cleanup.
      const lock: ServerLock = { pid: 1, port: 2, startedAt: 3, buildId: 'b', ...LEASE }
      await writeLock(lock)
      await removeLock('predecessor')
      expect(await readLock()).toEqual(lock)
    })

    it('is a no-op with an expected holder when the lock is missing', async () => {
      await expect(removeLock(LEASE.instance)).resolves.toBeUndefined()
    })
  })

  describe('isServerLock', () => {
    const full: ServerLock = { pid: 1, port: 2, startedAt: 3, buildId: 'b', ...LEASE }

    it('accepts a complete lock', () => {
      expect(isServerLock(full)).toBe(true)
    })

    it('rejects non-objects, null, and missing/mistyped fields', () => {
      expect(isServerLock('lock')).toBe(false)
      expect(isServerLock(null)).toBe(false)
      for (const key of Object.keys(full) as (keyof ServerLock)[]) {
        const { [key]: value, ...partial } = full
        expect(isServerLock(partial)).toBe(false)
        const wrongType = typeof value === 'number' ? 'nope' : 42
        expect(isServerLock({ ...full, [key]: wrongType })).toBe(false)
      }
    })
  })

  describe('parseServerLock', () => {
    it('parses a valid lock', () => {
      const lock: ServerLock = { pid: 1, port: 2, startedAt: 3, buildId: 'b', ...LEASE }
      expect(parseServerLock(JSON.stringify(lock))).toEqual(lock)
    })

    it('returns null on malformed JSON and wrong shapes', () => {
      expect(parseServerLock('not json')).toBeNull()
      expect(parseServerLock('{"pid":1}')).toBeNull()
    })
  })

  describe('isLockLive', () => {
    it('returns false for a dead pid', async () => {
      const lock: ServerLock = { pid: 999_999, port: 1, startedAt: 0, buildId: 'b', ...LEASE }
      expect(await isLockLive(lock)).toBe(false)
    })

    it('returns false when the pid is alive but no server listens', async () => {
      // Use the test runner pid (definitely alive) with an unbound port.
      const lock: ServerLock = { pid: process.pid, port: 1, startedAt: 0, buildId: 'b', ...LEASE }
      expect(await isLockLive(lock)).toBe(false)
    })

    it('returns true for any HTTP answer, even a 404 from a server predating /api/health', async () => {
      const server = http.createServer((_req, res) => { res.writeHead(404).end() })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('bad address')
      try {
        const lock: ServerLock = { pid: process.pid, port: addr.port, startedAt: 0, buildId: 'b', ...LEASE }
        expect(await isLockLive(lock)).toBe(true)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('judges an off-host lock by its lease, not by a pid or a port here', async () => {
      // For a server pod, the pid is from another pid namespace and the port
      // is bound inside the pod, so neither can be checked on this machine.
      const fresh: ServerLock = {
        pid: 1, port: 1, startedAt: 0, buildId: 'b',
        instance: 'i', host: 'yaac-server-abc123', heartbeatAt: Date.now(),
      }
      expect(await isLockLive(fresh)).toBe(true)
      expect(await isLockLive({ ...fresh, heartbeatAt: Date.now() - LEASE_STALE_MS - 1 }))
        .toBe(false)
    })
  })

  describe('isSameHostLock', () => {
    it('is this host only when the lock names it', () => {
      const lock: ServerLock = { pid: 1, port: 1, startedAt: 0, buildId: 'b', ...LEASE }
      expect(isSameHostLock(lock)).toBe(true)
      expect(isSameHostLock({ ...lock, host: 'some-pod' })).toBe(false)
    })
  })

  describe('isLeaseFresh', () => {
    it('is the cross-host liveness signal, bounded by four missed renewals', () => {
      const base: ServerLock = { pid: 1, port: 1, startedAt: 0, buildId: 'b', ...LEASE }
      expect(isLeaseFresh({ ...base, heartbeatAt: Date.now() })).toBe(true)
      expect(isLeaseFresh({ ...base, heartbeatAt: Date.now() - LEASE_STALE_MS + 500 })).toBe(true)
      expect(isLeaseFresh({ ...base, heartbeatAt: Date.now() - LEASE_STALE_MS - 1 })).toBe(false)
      expect(LEASE_STALE_MS / LEASE_HEARTBEAT_MS).toBe(4)
    })
  })

  describe('newLeaseFields', () => {
    it('mints the three fields together, so a pid is never read out of context', () => {
      // Without a host, the pid could be from any namespace.
      const a = newLeaseFields()
      const b = newLeaseFields()
      expect(a.instance).not.toBe(b.instance)
      expect(a.host).toBe(os.hostname())
      expect(a.heartbeatAt).toBeGreaterThan(0)
    })
  })

  describe('renewLease', () => {
    it('moves the heartbeat forward while we hold the lock', async () => {
      const lease = newLeaseFields()
      const lock: ServerLock = {
        pid: process.pid, port: 1, startedAt: 0, buildId: 'b', ...lease,
        heartbeatAt: Date.now() - 10_000,
      }
      await writeLock(lock)
      expect(await renewLease(lease.instance)).toBe(true)
      expect((await readLock())!.heartbeatAt).toBeGreaterThan(lock.heartbeatAt)
    })

    it('reports the loss rather than resurrecting us as the owner', async () => {
      // Another server may have taken the lock while this one was paused. On
      // hostPath storage the lease guards PGlite's single writer, so the
      // caller must act on `false` rather than retry.
      await writeLock({
        pid: 2, port: 1, startedAt: 0, buildId: 'b',
        instance: 'successor', host: 'other-pod', heartbeatAt: Date.now(),
      })
      expect(await renewLease('predecessor')).toBe(false)
      expect((await readLock())?.instance).toBe('successor')
    })

    it('reports the loss when the lock is gone entirely', async () => {
      expect(await renewLease('whatever')).toBe(false)
    })
  })

  describe('isLockReady', () => {
    // A fake /health, so `ready` can vary independently of liveness.
    async function withHealth(
      body: string,
      run: (lock: ServerLock) => Promise<void>,
    ): Promise<void> {
      const server = http.createServer((req, res) => {
        if (req.url === '/api/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
        } else {
          res.writeHead(404).end()
        }
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('bad address')
      try {
        await run({ pid: process.pid, port: addr.port, startedAt: 0, buildId: 'b', ...LEASE })
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }

    it('returns false for a dead pid without probing', async () => {
      const lock: ServerLock = { pid: 999_999, port: 1, startedAt: 0, buildId: 'b', ...LEASE }
      expect(await isLockReady(lock)).toBe(false)
    })

    it('returns false when the pid is alive but no server listens', async () => {
      const lock: ServerLock = { pid: process.pid, port: 1, startedAt: 0, buildId: 'b', ...LEASE }
      expect(await isLockReady(lock)).toBe(false)
    })

    it('returns true when /health reports ready: true', async () => {
      await withHealth('{"ok":true,"ready":true}', async (lock) => {
        expect(await isLockReady(lock)).toBe(true)
      })
    })

    it('returns false when /health is live but reports ready: false', async () => {
      // Up and answering but still initializing: not ready.
      await withHealth('{"ok":true,"ready":false}', async (lock) => {
        expect(await isLockReady(lock)).toBe(false)
      })
    })

    it('returns false when /health omits the ready field (older/partial body)', async () => {
      await withHealth('{"ok":true}', async (lock) => {
        expect(await isLockReady(lock)).toBe(false)
      })
    })
  })

  describe('acquireLock', () => {
    const mkLock = (overrides: Partial<ServerLock> = {}): ServerLock => ({
      pid: process.pid,
      port: 1,
      startedAt: Date.now(),
      buildId: 'b',
      ...newLeaseFields(),
      ...overrides,
    })

    it('creates the lock file and returns { acquired: true }', async () => {
      const lock = mkLock()
      const result = await acquireLock(lock)
      expect(result).toEqual({ acquired: true })
      expect(await readLock()).toEqual(lock)
      const stat = await fs.stat(serverLockPath())
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('reports the existing lock when a live server already holds it', async () => {
      const server = http.createServer((req, res) => {
        if (req.url === '/api/health') { res.writeHead(200).end('{"ok":true}') }
        else res.writeHead(404).end()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('bad address')
      try {
        const held = mkLock({ port: addr.port, pid: process.pid })
        await writeLock(held)
        const result = await acquireLock(mkLock())
        expect(result).toEqual({ acquired: false, existing: held })
        // The existing lock file must not be overwritten.
        expect(await readLock()).toEqual(held)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('reclaims a stale lock (dead pid) and acquires', async () => {
      await writeLock(mkLock({ pid: 999_999 }))
      const fresh = mkLock()
      const result = await acquireLock(fresh)
      expect(result).toEqual({ acquired: true })
      expect(await readLock()).toEqual(fresh)
    })

    it('reclaims an unparseable lock file and acquires', async () => {
      await fs.writeFile(serverLockPath(), 'not json')
      const fresh = mkLock()
      const result = await acquireLock(fresh)
      expect(result).toEqual({ acquired: true })
      expect(await readLock()).toEqual(fresh)
    })

    it('exactly one caller wins when many acquires race concurrently', async () => {
      // All callers share one live /health port, as each real runServer
      // attempt has bound its own, so losers see the winner's lock as live.
      const server = http.createServer((req, res) => {
        if (req.url === '/api/health') { res.writeHead(200).end('{"ok":true}') }
        else res.writeHead(404).end()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('bad address')
      try {
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            acquireLock(mkLock({ port: addr.port, startedAt: 1000 + i }))),
        )
        const winners = results.filter((r) => r.acquired)
        expect(winners).toHaveLength(1)
        const losers = results.filter((r) => !r.acquired) as Array<{ acquired: false; existing: ServerLock }>
        expect(losers).toHaveLength(15)
        const onDisk = await readLock()
        expect(onDisk).not.toBeNull()
        for (const l of losers) {
          expect(l.existing).toEqual(onDisk)
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })
})
