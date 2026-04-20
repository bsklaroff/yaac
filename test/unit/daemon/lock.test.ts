import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import {
  daemonLockPath,
  readLock,
  writeLock,
  removeLock,
  isLockLive,
  type DaemonLock,
} from '@/lib/daemon/lock'

describe('daemon lock', () => {
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
      await fs.writeFile(daemonLockPath(), 'not json')
      expect(await readLock()).toBeNull()
    })

    it('returns null when required fields are missing', async () => {
      await fs.writeFile(daemonLockPath(), JSON.stringify({ pid: 123 }))
      expect(await readLock()).toBeNull()
    })

    it('returns the parsed lock when valid', async () => {
      const lock: DaemonLock = { pid: 1, port: 2, secret: 's', startedAt: 3, buildId: 'b' }
      await fs.writeFile(daemonLockPath(), JSON.stringify(lock))
      expect(await readLock()).toEqual(lock)
    })
  })

  describe('writeLock', () => {
    it('writes the lock with mode 0600', async () => {
      const lock: DaemonLock = { pid: 1, port: 2, secret: 'shh', startedAt: 3, buildId: 'b' }
      await writeLock(lock)
      const stat = await fs.stat(daemonLockPath())
      // Bottom 9 bits of mode are the rwxrwxrwx triplet.
      expect(stat.mode & 0o777).toBe(0o600)
      expect(JSON.parse(await fs.readFile(daemonLockPath(), 'utf8'))).toEqual(lock)
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
  })

  describe('isLockLive', () => {
    it('returns false for a dead pid', async () => {
      const lock: DaemonLock = { pid: 999_999, port: 1, secret: 's', startedAt: 0, buildId: 'b' }
      expect(await isLockLive(lock)).toBe(false)
    })

    it('returns false when the pid is alive but no server listens', async () => {
      // Use the test runner pid (definitely alive) with an unbound port.
      const lock: DaemonLock = { pid: process.pid, port: 1, secret: 's', startedAt: 0, buildId: 'b' }
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
        const lock: DaemonLock = { pid: process.pid, port: addr.port, secret: 's', startedAt: 0, buildId: 'b' }
        expect(await isLockLive(lock)).toBe(true)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })
})
