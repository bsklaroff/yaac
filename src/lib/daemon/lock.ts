import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir } from '@/lib/project/paths'

export interface DaemonLock {
  pid: number
  port: number
  secret: string
  startedAt: number
  buildId: string
}

export function daemonLockPath(): string {
  return path.join(getDataDir(), '.daemon.lock')
}

export async function readLock(): Promise<DaemonLock | null> {
  try {
    const raw = await fs.readFile(daemonLockPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isDaemonLock(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeLock(lock: DaemonLock): Promise<void> {
  const p = daemonLockPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  // Write to a temp file first, then rename so a reader never observes a
  // half-written lock. chmod 600 because the file contains a bearer secret.
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(lock), { mode: 0o600 })
  await fs.rename(tmp, p)
}

export async function removeLock(): Promise<void> {
  try {
    await fs.unlink(daemonLockPath())
  } catch {
    // already gone
  }
}

/**
 * A lock is "live" if (a) the pid still exists and (b) /health answers
 * within 500ms. Used both by the CLI (is there a daemon to talk to?) and
 * by a second `yaac daemon` invocation (should I exit idempotently?).
 */
export async function isLockLive(lock: DaemonLock): Promise<boolean> {
  if (!pidExists(lock.pid)) return false
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 500)
    try {
      const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
        headers: { authorization: `Bearer ${lock.secret}` },
        signal: ctl.signal,
      })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we can't signal it — still alive.
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function isDaemonLock(value: unknown): value is DaemonLock {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pid === 'number'
    && typeof v.port === 'number'
    && typeof v.secret === 'string'
    && typeof v.startedAt === 'number'
    && typeof v.buildId === 'string'
  )
}
