import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  authDaemonLockPath,
  isPidLive,
  readAuthDaemonLock,
  removeAuthDaemonLock,
  writeAuthDaemonLock,
} from '@yaac/shared/auth-daemon'
import { setDataDir } from '@yaac/shared/paths'

describe('auth server lock', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-authd-'))
    setDataDir(dir)
  })

  afterEach(async () => {
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trips the lock at mode 0600', async () => {
    const lock = { pid: process.pid, baseUrl: 'http://127.0.0.1:8787', startedAt: 123 }
    await writeAuthDaemonLock(lock)
    expect(await readAuthDaemonLock()).toEqual(lock)
    const stat = await fs.stat(authDaemonLockPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('returns null for a missing, malformed, or wrong-shaped lock', async () => {
    expect(await readAuthDaemonLock()).toBeNull()
    await fs.writeFile(authDaemonLockPath(), 'not json')
    expect(await readAuthDaemonLock()).toBeNull()
    await fs.writeFile(authDaemonLockPath(), JSON.stringify({ pid: 'x' }))
    expect(await readAuthDaemonLock()).toBeNull()
  })

  it('remove is idempotent', async () => {
    await writeAuthDaemonLock({ pid: 1, baseUrl: 'http://x', startedAt: 0 })
    await removeAuthDaemonLock()
    expect(await readAuthDaemonLock()).toBeNull()
    await removeAuthDaemonLock()
  })
})

describe('isPidLive', () => {
  it('sees the current process and not a certainly-dead pid', () => {
    expect(isPidLive(process.pid)).toBe(true)
    // PID guaranteed unused: beyond typical pid_max on test hosts.
    expect(isPidLive(2 ** 30)).toBe(false)
  })
})
