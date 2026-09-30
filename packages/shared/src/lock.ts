import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serverLocalPath } from '#paths'
import { SERVER_LOCK_FILENAME, isLockLive, parseServerLock, type ServerLock } from '#server-lock-file'

/** SERVER-LOCAL: the lock is 1:1 with the server process. */
export function serverLockPath(): string {
  return serverLocalPath(SERVER_LOCK_FILENAME)
}

export async function readLock(): Promise<ServerLock | null> {
  try {
    return parseServerLock(await fs.readFile(serverLockPath(), 'utf8'))
  } catch {
    return null
  }
}

export async function writeLock(lock: ServerLock): Promise<void> {
  const p = serverLockPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  // Temp file + rename so a reader never sees a half-written lock.
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(lock), { mode: 0o600 })
  await fs.rename(tmp, p)
}

/**
 * The lease fields of a fresh lock: a random instance id, this host's name,
 * and a first heartbeat. Created together so no lock carries one without
 * the others.
 */
export function newLeaseFields(): Pick<ServerLock, 'instance' | 'host' | 'heartbeatAt'> {
  return {
    instance: crypto.randomBytes(8).toString('hex'),
    host: os.hostname(),
    heartbeatAt: Date.now(),
  }
}

/**
 * Renew our lease and report whether we still hold it. Checks the instance
 * first so a server whose lease went stale (e.g. while paused) never
 * overwrites a successor's lock. `false` means this process is no longer
 * the install's server.
 */
export async function renewLease(instance: string): Promise<boolean> {
  const cur = await readLock()
  if (!cur || cur.instance !== instance) return false
  await writeLock({ ...cur, heartbeatAt: Date.now() })
  return true
}

/**
 * Atomically acquire the server lock; `O_EXCL` ensures only one racing
 * process wins the create. Returns `{ acquired: false, existing }` when
 * another live server holds it, and the caller then cleans up and exits.
 *
 * A stale lock is deleted, but only if its instance still matches the one
 * we read, so a fresh lock written in between survives; then the create is
 * retried.
 */
export async function acquireLock(
  lock: ServerLock,
): Promise<{ acquired: true } | { acquired: false; existing: ServerLock }> {
  const p = serverLockPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  const payload = JSON.stringify(lock)
  const maxAttempts = 10
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const h = await fs.open(p, 'wx', 0o600)
      try {
        await h.writeFile(payload)
      } finally {
        await h.close()
      }
      return { acquired: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const existing = await readLock()
    if (existing && await isLockLive(existing)) {
      return { acquired: false, existing }
    }
    // An unparseable file (`existing` null) is deleted unconditionally.
    try {
      const cur = await readLock()
      const stillStale = !existing || !cur || cur.instance === existing.instance
      if (stillStale) {
        await fs.unlink(p)
      }
    } catch {
      // already gone — retry
    }
  }
  throw new Error('failed to acquire server lock after retries')
}

/**
 * Remove the server lock file. With `expectedInstance`, only if the lock
 * still names that instance, so a server that hung during shutdown cannot
 * later delete its successor's lock. Without it, unconditionally, for
 * callers that already judged the lock stale.
 */
export async function removeLock(expectedInstance?: string): Promise<void> {
  if (expectedInstance !== undefined) {
    const cur = await readLock()
    if (cur?.instance !== expectedInstance) return
  }
  try {
    await fs.unlink(serverLockPath())
  } catch {
    // already gone
  }
}

