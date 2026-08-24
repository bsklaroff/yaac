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
      const lock: ServerLock = { pid: 1, port: 2, secret: 's', startedAt: 3, buildId: 'b' }
      await fs.writeFile(serverLockPath(), JSON.stringify(lock))
      expect(await readLock()).toEqual(lock)
    })
  })

  describe('writeLock', () => {
    it('writes the lock with mode 0600', async () => {
      const lock: ServerLock = { pid: 1, port: 2, secret: 'shh', startedAt: 3, buildId: 'b' }
      await writeLock(lock)
      const stat = await fs.stat(serverLockPath())
      // Bottom 9 bits of mode are the rwxrwxrwx triplet.
      expect(stat.mode & 0o777).toBe(0o600)
      expect(JSON.parse(await fs.readFile(serverLockPath(), 'utf8'))).toEqual(lock)
    })

    it('overwrites an existing lock atomically', async () => {
      await writeLock({ pid: 1, port: 2, secret: 'a', startedAt: 3, buildId: 'b1' })
      await writeLock({ pid: 9, port: 8, secret: 'b', startedAt: 7, buildId: 'b2' })
      expect(await readLock()).toEqual({ pid: 9, port: 8, secret: 'b', startedAt: 7, buildId: 'b2' })
    })
  })

  describe('removeLock', () => {
    it('unlinks the lock', async () => {
      await writeLock({ pid: 1, port: 2, secret: 's', startedAt: 3, buildId: 'b' })
      await removeLock()
      expect(await readLock()).toBeNull()
    })

    it('is a no-op when the lock is missing', async () => {
      await expect(removeLock()).resolves.toBeUndefined()
    })

    it('unlinks when the expected holder matches', async () => {
      const lock: ServerLock = { pid: 42, port: 2, secret: 's', startedAt: 3, buildId: 'b' }
      await writeLock(lock)
      await removeLock({ pid: 42 })
      expect(await readLock()).toBeNull()
    })

    it('leaves the lock alone when the expected holder does not match', async () => {
      const lock: ServerLock = { pid: 42, port: 2, secret: 's', startedAt: 3, buildId: 'b' }
      await writeLock(lock)
      await removeLock({ pid: 999 })
      expect(await readLock()).toEqual(lock)
    })

    it('is a no-op with an expected holder when the lock is missing', async () => {
      await expect(removeLock({ pid: 42 })).resolves.toBeUndefined()
    })

    it('identifies the holder by instance, not pid, once both carry one', async () => {
      // Two servers of one install can genuinely both be pid 1 (each pod's
      // pid namespace hands out the same low numbers), so a successor's
      // lock must survive its predecessor's late cleanup.
      const successor: ServerLock = {
        pid: 1, port: 2, secret: 's', startedAt: 9, buildId: 'b',
        instance: 'successor', host: 'pod-b', heartbeatAt: Date.now(),
      }
      await writeLock(successor)
      await removeLock({ pid: 1, instance: 'predecessor' })
      expect(await readLock()).toEqual(successor)
      await removeLock({ pid: 1, instance: 'successor' })
      expect(await readLock()).toBeNull()
    })
  })

  describe('isServerLock', () => {
    const full: ServerLock = { pid: 1, port: 2, secret: 's', startedAt: 3, buildId: 'b' }

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
      const lock: ServerLock = { pid: 1, port: 2, secret: 's', startedAt: 3, buildId: 'b' }
      expect(parseServerLock(JSON.stringify(lock))).toEqual(lock)
    })

    it('returns null on malformed JSON and wrong shapes', () => {
      expect(parseServerLock('not json')).toBeNull()
      expect(parseServerLock('{"pid":1}')).toBeNull()
    })
  })

  describe('isLockLive', () => {
    it('returns false for a dead pid', async () => {
      const lock: ServerLock = { pid: 999_999, port: 1, secret: 's', startedAt: 0, buildId: 'b' }
      expect(await isLockLive(lock)).toBe(false)
    })

    it('returns false when the pid is alive but no server listens', async () => {
      // Use the test runner pid (definitely alive) with an unbound port.
      const lock: ServerLock = { pid: process.pid, port: 1, secret: 's', startedAt: 0, buildId: 'b' }
      expect(await isLockLive(lock)).toBe(false)
    })

    it('returns true when /health responds 2xx', async () => {
      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        } else {
          res.writeHead(404).end()
        }
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('bad address')
      try {
        const lock: ServerLock = { pid: process.pid, port: addr.port, secret: 's', startedAt: 0, buildId: 'b' }
        expect(await isLockLive(lock)).toBe(true)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('judges an off-host lock by its lease, not by a pid or a port here', async () => {
      // Once the server can be a pod, both local signals lie: every pid
      // namespace hands out the same low pids, and the lock's port is the
      // one bound INSIDE the pod — so `127.0.0.1:<that>` on this machine is
      // an unrelated listener, quite possibly another yaac.
      const fresh: ServerLock = {
        pid: 1, port: 1, secret: 's', startedAt: 0, buildId: 'b',
        instance: 'i', host: 'yaac-server-abc123', heartbeatAt: Date.now(),
      }
      expect(await isLockLive(fresh)).toBe(true)
      expect(await isLockLive({ ...fresh, heartbeatAt: Date.now() - LEASE_STALE_MS - 1 }))
        .toBe(false)
      // A foreign lock with no lease at all is takeable rather than
      // permanently held — there is nothing that could ever refresh it.
      expect(await isLockLive({ ...fresh, heartbeatAt: undefined })).toBe(false)
    })
  })

  describe('isSameHostLock', () => {
    it('reads a lock with no host as this host — which is what it was', () => {
      // Locks written before the lease carry none, and they were always
      // this machine's (see docs/legacy-compat-shims.md).
      expect(isSameHostLock({ pid: 1, port: 1, secret: 's', startedAt: 0, buildId: 'b' }))
        .toBe(true)
      expect(isSameHostLock({
        pid: 1, port: 1, secret: 's', startedAt: 0, buildId: 'b', host: os.hostname(),
      })).toBe(true)
      expect(isSameHostLock({
        pid: 1, port: 1, secret: 's', startedAt: 0, buildId: 'b', host: 'some-pod',
      })).toBe(false)
    })
  })

  describe('isLeaseFresh', () => {
    it('is the cross-host liveness signal, bounded by four missed renewals', () => {
      const base: ServerLock = { pid: 1, port: 1, secret: 's', startedAt: 0, buildId: 'b' }
      expect(isLeaseFresh({ ...base, heartbeatAt: Date.now() })).toBe(true)
      expect(isLeaseFresh({ ...base, heartbeatAt: Date.now() - LEASE_STALE_MS + 500 })).toBe(true)
      expect(isLeaseFresh({ ...base, heartbeatAt: Date.now() - LEASE_STALE_MS - 1 })).toBe(false)
      expect(isLeaseFresh(base)).toBe(false)
      expect(LEASE_STALE_MS / LEASE_HEARTBEAT_MS).toBe(4)
    })
  })

  describe('newLeaseFields', () => {
    it('mints the three fields together, so a pid is never read out of context', () => {
      // A lock carrying an instance but no host would be judged by a pid in
      // whichever namespace happened to write it.
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
        pid: process.pid, port: 1, secret: 's', startedAt: 0, buildId: 'b', ...lease,
        heartbeatAt: Date.now() - 10_000,
      }
      await writeLock(lock)
      expect(await renewLease(lease.instance!)).toBe(true)
      expect((await readLock())!.heartbeatAt).toBeGreaterThan(lock.heartbeatAt!)
    })

    it('reports the loss rather than resurrecting us as the owner', async () => {
      // If another server took the lock over while this one was paused, a
      // blind rewrite would put a stale identity back on a live install —
      // and on hostPath storage the lease IS PGlite's single-writer guard,
      // so the caller has to act on the false rather than retry.
      await writeLock({
        pid: 2, port: 1, secret: 's', startedAt: 0, buildId: 'b',
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
    // Spin up a fake /health that returns `body` so we can vary the `ready`
    // field independently of liveness.
    async function withHealth(
      body: string,
      run: (lock: ServerLock) => Promise<void>,
    ): Promise<void> {
      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
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
        await run({ pid: process.pid, port: addr.port, secret: 's', startedAt: 0, buildId: 'b' })
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }

    it('returns false for a dead pid without probing', async () => {
      const lock: ServerLock = { pid: 999_999, port: 1, secret: 's', startedAt: 0, buildId: 'b' }
      expect(await isLockReady(lock)).toBe(false)
    })

    it('returns false when the pid is alive but no server listens', async () => {
      const lock: ServerLock = { pid: process.pid, port: 1, secret: 's', startedAt: 0, buildId: 'b' }
      expect(await isLockReady(lock)).toBe(false)
    })

    it('returns true when /health reports ready: true', async () => {
      await withHealth('{"ok":true,"ready":true}', async (lock) => {
        expect(await isLockReady(lock)).toBe(true)
      })
    })

    it('returns false when /health is live but reports ready: false', async () => {
      // The exact race the readiness gate closes: the server is up and
      // answering, but still initializing, so it must not be treated as ready.
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
      secret: 's',
      startedAt: Date.now(),
      buildId: 'b',
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
        if (req.url === '/health') { res.writeHead(200).end('{"ok":true}') }
        else res.writeHead(404).end()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('bad address')
      try {
        const held = mkLock({ port: addr.port, pid: process.pid, secret: 'held' })
        await writeLock(held)
        const result = await acquireLock(mkLock({ secret: 'other' }))
        expect(result).toEqual({ acquired: false, existing: held })
        // The existing lock file must not be overwritten.
        expect(await readLock()).toEqual(held)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('reclaims a stale lock (dead pid) and acquires', async () => {
      await writeLock(mkLock({ pid: 999_999, secret: 'stale' }))
      const fresh = mkLock({ secret: 'fresh' })
      const result = await acquireLock(fresh)
      expect(result).toEqual({ acquired: true })
      expect(await readLock()).toEqual(fresh)
    })

    it('reclaims an unparseable lock file and acquires', async () => {
      await fs.writeFile(serverLockPath(), 'not json')
      const fresh = mkLock({ secret: 'fresh' })
      const result = await acquireLock(fresh)
      expect(result).toEqual({ acquired: true })
      expect(await readLock()).toEqual(fresh)
    })

    it('exactly one caller wins when many acquires race concurrently', async () => {
      // All 16 callers share the same /health port so isLockLive returns
      // true for whichever caller wins — otherwise losers would see the
      // winner's lock as stale and clobber it. In the real runServer
      // flow, each attempt has just bound a real port, so the analog of
      // this "live port" holds by construction.
      const server = http.createServer((req, res) => {
        if (req.url === '/health') { res.writeHead(200).end('{"ok":true}') }
        else res.writeHead(404).end()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('bad address')
      try {
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            acquireLock(mkLock({ port: addr.port, secret: `s${i}`, startedAt: 1000 + i }))),
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
