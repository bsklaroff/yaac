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
  // Write to a temp file first, then rename so a reader never observes a
  // half-written lock. chmod 600 because the file contains a bearer secret.
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(lock), { mode: 0o600 })
  await fs.rename(tmp, p)
}

/**
 * The lease half of a fresh lock: an identity this process alone holds, the
 * hostname (or pod name) that says whose pid namespace the `pid` field
 * belongs to, and a first heartbeat.
 *
 * Minted here rather than at the call site so the three always travel
 * together — a lock carrying an instance but no host would be judged by a
 * pid in the wrong namespace.
 */
export function newLeaseFields(): Pick<ServerLock, 'instance' | 'host' | 'heartbeatAt'> {
  return {
    instance: crypto.randomBytes(8).toString('hex'),
    host: os.hostname(),
    heartbeatAt: Date.now(),
  }
}

/**
 * Renew our lease in place, and report whether we still hold it.
 *
 * Read-compare-write rather than a blind rewrite: if another server has
 * taken the lock over (ours went stale while this process was paused, and
 * it lost the race it should have lost), the heartbeat must not resurrect
 * us as the apparent owner. `false` means "this process is no longer the
 * install's server", which is a fact the caller has to act on rather than
 * paper over.
 */
export async function renewLease(instance: string): Promise<boolean> {
  const cur = await readLock()
  if (!cur || cur.instance !== instance) return false
  await writeLock({ ...cur, heartbeatAt: Date.now() })
  return true
}

/**
 * Whether two lock reads describe the same holder. Instance when both
 * carry one (the lease), else the pid+startedAt pair that identified a
 * host process before the lease existed.
 */
function sameHolder(a: ServerLock, b: ServerLock): boolean {
  if (a.instance !== undefined && b.instance !== undefined) return a.instance === b.instance
  return a.pid === b.pid && a.startedAt === b.startedAt
}

/**
 * Atomically acquire the server lock. POSIX `O_EXCL` guarantees only one
 * process wins the create, even when two `yaac server run` invocations race
 * past the pre-bind fast-path check in runServer and both try to take the
 * lock at the same moment.
 *
 * Returns `{ acquired: true }` when this process now owns the lock — the
 * file has been written with `lock`'s contents and mode 0600.
 *
 * Returns `{ acquired: false, existing }` when another live server holds
 * the lock. The caller is responsible for tearing down any resources it
 * allocated (e.g. a bound server) and exiting idempotently.
 *
 * A stale lock (dead pid, or `/health` unresponsive) is reclaimed: the
 * file is unlinked only if it still matches the stale lock we observed —
 * a pid+startedAt compare-and-delete — so a fresh lock that raced into
 * place between our read and unlink isn't clobbered. The create is then
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
    // Stale lock (or garbage mid-write). Compare-and-delete so we don't
    // clobber a fresh lock that landed between readLock() and unlink().
    // A null `existing` here means readLock() couldn't parse the file —
    // unlink unconditionally in that case so we can retry.
    try {
      const cur = await readLock()
      const stillStale = !existing || !cur || sameHolder(cur, existing)
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
 * Remove the server lock file.
 *
 * With `expected`, only unlink when the on-disk lock still names that
 * holder. This guards against a zombified shutdown (e.g. a previous server
 * that hung past `stopServer`'s 3s force-remove timeout) clobbering a
 * successor server's lock when it eventually unblocks. The holder is the
 * lease instance where there is one, because a pid does not identify a
 * server across pods.
 *
 * Without `expected`, unlink unconditionally — appropriate for callers
 * that have already classified the lock as stale (dead pid / unresponsive
 * /health, or an expired lease) and simply need to clear the file before a
 * fresh spawn.
 */
export async function removeLock(
  expected?: { pid: number; instance?: string },
): Promise<void> {
  if (expected !== undefined) {
    const cur = await readLock()
    if (!cur) return
    const ours = expected.instance !== undefined && cur.instance !== undefined
      ? cur.instance === expected.instance
      : cur.pid === expected.pid
    if (!ours) return
  }
  try {
    await fs.unlink(serverLockPath())
  } catch {
    // already gone
  }
}

