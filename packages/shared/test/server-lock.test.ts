import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  acquireLock,
  serverLockPath,
  readLock,
  writeLock,
  removeLock,
} from '#lock'
import {
  isLockLive,
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

    it('unlinks when the pid matches expectedPid', async () => {
      const lock: ServerLock = { pid: 42, port: 2, secret: 's', startedAt: 3, buildId: 'b' }
      await writeLock(lock)
      await removeLock(42)
      expect(await readLock()).toBeNull()
    })

    it('leaves the lock alone when expectedPid does not match', async () => {
      const lock: ServerLock = { pid: 42, port: 2, secret: 's', startedAt: 3, buildId: 'b' }
      await writeLock(lock)
      await removeLock(999)
      expect(await readLock()).toEqual(lock)
    })

    it('is a no-op with expectedPid when the lock is missing', async () => {
      await expect(removeLock(42)).resolves.toBeUndefined()
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
