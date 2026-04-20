import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readBuildId } from '@/lib/build-id'
import { daemonLockPath, readLock, isLockLive, removeLock, type DaemonLock } from '@/lib/daemon/lock'
import {
  exitCodeForError,
  type DaemonErrorBody,
  type ErrorCode,
} from '@/lib/daemon/errors'

const __filename = fileURLToPath(import.meta.url)

export class DaemonClientError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'DaemonClientError'
  }
}

export interface DaemonClient {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  delete<T>(path: string): Promise<T>
}

export interface GetClientOptions {
  /**
   * Injected for tests. Resolves to a live lock (spawning the daemon if
   * necessary) and returns the bearer/port to use for requests.
   */
  resolveLock?: () => Promise<DaemonLock>
  fetchImpl?: typeof fetch
  /**
   * Interactive "please re-authenticate" handler. Invoked once when the
   * daemon replies with `AUTH_REQUIRED`; after it resolves the request
   * is retried once. The CLI wires this to `authUpdate`; tests inject
   * their own.
   */
  onAuthRequired?: () => Promise<void>
}

export async function getClient(opts: GetClientOptions = {}): Promise<DaemonClient> {
  const resolveLock = opts.resolveLock ?? defaultResolveLock
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const onAuthRequired = opts.onAuthRequired ?? defaultAuthUpdate

  let lock = await resolveLock()

  async function request<T>(pathname: string, init: RequestInit): Promise<T> {
    const send = async (): Promise<Response> => fetchImpl(
      `http://127.0.0.1:${lock.port}${pathname}`,
      withAuth(init, lock.secret),
    )

    let res = await send()

    if (res.status === 401) {
      const body = await peekErrorBody(res)
      if (body?.error.code === 'BAD_BEARER') {
        const refreshed = await resolveLock()
        if (refreshed.secret !== lock.secret || refreshed.port !== lock.port) {
          lock = refreshed
          res = await send()
        }
      } else if (body?.error.code === 'AUTH_REQUIRED') {
        await onAuthRequired()
        res = await send()
        // A second AUTH_REQUIRED is fatal — fall through to the normal
        // error-mapping path below so the user sees the daemon's message.
      }
    }

    if (!res.ok) throw await toClientError(res)
    const text = await res.text()
    return text ? (JSON.parse(text) as T) : (undefined as T)
  }

  return {
    get: <T>(p: string) => request<T>(p, { method: 'GET' }),
    post: <T>(p: string, body?: unknown) => request<T>(p, jsonInit('POST', body)),
    put: <T>(p: string, body?: unknown) => request<T>(p, jsonInit('PUT', body)),
    delete: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  if (body === undefined) return { method }
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function withAuth(init: RequestInit, secret: string): RequestInit {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer ${secret}`)
  headers.set('accept', 'application/json')
  return { ...init, headers }
}

async function peekErrorBody(res: Response): Promise<DaemonErrorBody | null> {
  try {
    // `Response.json()` consumes the body — clone so the fall-through
    // error path can still read it.
    return await res.clone().json() as DaemonErrorBody
  } catch {
    return null
  }
}

async function toClientError(res: Response): Promise<DaemonClientError> {
  try {
    const body = await res.json() as DaemonErrorBody
    return new DaemonClientError(body.error.code, body.error.message)
  } catch {
    return new DaemonClientError('INTERNAL', `daemon returned ${res.status}`)
  }
}

/**
 * Default `AUTH_REQUIRED` recovery: run the interactive `auth update`
 * flow. Imported lazily so the daemon process (which also links this
 * module for the shared error taxonomy) doesn't pull the readline-using
 * command into its bundle unless the CLI path actually needs it.
 */
async function defaultAuthUpdate(): Promise<void> {
  const mod = await import('@/commands/auth-update')
  await mod.authUpdate()
}

/**
 * Discover a running daemon or spawn one. Returns a live lock whose
 * `buildId` matches the CLI's installed build.
 *
 * - If `YAAC_DAEMON_URL` + `YAAC_DAEMON_SECRET` are set, use them
 *   directly. This is the test injection hook: tests boot an
 *   in-process daemon and point the CLI at it without writing the
 *   shared `~/.yaac/.daemon.lock`. Production never sets these.
 * - Otherwise read `~/.yaac/.daemon.lock`. If live and the `buildId`
 *   matches, return it.
 * - If the lock is live but its `buildId` doesn't match our install,
 *   SIGTERM the stale daemon, wait for it to release the lock, then
 *   spawn a fresh one.
 * - Otherwise spawn `yaac daemon` detached and poll the lock for
 *   up to 5s.
 */
async function defaultResolveLock(): Promise<DaemonLock> {
  const envUrl = process.env.YAAC_DAEMON_URL
  const envSecret = process.env.YAAC_DAEMON_SECRET
  if (envUrl && envSecret) {
    const url = new URL(envUrl)
    return {
      pid: -1,
      port: Number(url.port),
      secret: envSecret,
      startedAt: 0,
      buildId: process.env.YAAC_DAEMON_BUILD_ID ?? '',
    }
  }

  const buildId = await readBuildId()
  const existing = await readLock()
  if (existing && await isLockLive(existing)) {
    if (existing.buildId === buildId) return existing
    await stopStaleDaemon(existing)
  }

  await spawnDaemon()
  const fresh = await waitForLiveLock(5000)
  if (fresh.buildId !== buildId) {
    throw new DaemonClientError(
      'INTERNAL',
      `daemon buildId ${fresh.buildId} does not match CLI buildId ${buildId}`,
    )
  }
  return fresh
}

/**
 * Terminate a stale daemon and wait for its lock file to disappear
 * (the daemon's shutdown handler unlinks it on SIGTERM). If the
 * daemon doesn't exit cleanly within the deadline, force-remove the
 * lock so the next spawn isn't confused by leftover state.
 */
async function stopStaleDaemon(lock: DaemonLock): Promise<void> {
  try {
    process.kill(lock.pid, 'SIGTERM')
  } catch {
    // Process already gone — still need to clear the lock below.
  }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const cur = await readLock()
    if (!cur || cur.pid !== lock.pid) return
    await new Promise((r) => setTimeout(r, 50))
  }
  // Daemon didn't clean up in time. Remove the lock ourselves so the
  // next spawn sees a clean slate — the old process is either gone or
  // wedged, either way it's no longer the source of truth.
  const cur = await readLock()
  if (cur && cur.pid === lock.pid) {
    await removeLock()
    console.error(`[yaac] force-removed stale lock at ${daemonLockPath()} (pid ${lock.pid})`)
  }
}

async function spawnDaemon(): Promise<void> {
  const { bin, args } = resolveDaemonInvocation()
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  // If the spawn itself fails immediately (e.g. ENOENT), surface it.
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    // A spawned detached process won't emit a useful signal here, so
    // give it a tick and assume success — the lock poll will catch
    // the actual failure mode (e.g. "daemon never wrote the lock").
    setTimeout(resolve, 50)
  })
}

/**
 * Figure out how to relaunch ourselves as `yaac daemon`.
 *
 * - Production build (`dist/index.js`): `process.execPath` is node and
 *   `argv[1]` is the bundled entry — just reuse both.
 * - Dev (source `.ts` files): we're running under tsx. tsx strips its
 *   own CLI script from argv before running the target, so `argv[1]`
 *   is the source entry (`src/index.ts`). Respawn via tsx's CLI so the
 *   loader is set up again in the child.
 */
function resolveDaemonInvocation(): { bin: string; args: string[] } {
  const entry = process.argv[1] ?? ''
  if (entry.endsWith('.ts')) {
    const tsxCli = findTsxCli()
    if (tsxCli) return { bin: process.execPath, args: [tsxCli, entry, 'daemon'] }
    // Fallback: launch via node and hope NODE_OPTIONS carries the loader.
    return { bin: process.execPath, args: [entry, 'daemon'] }
  }
  return { bin: process.execPath, args: [entry, 'daemon'] }
}

function findTsxCli(): string | null {
  const here = path.dirname(__filename)
  // Walk up from src/lib/ looking for node_modules/tsx/dist/cli.mjs (or
  // the pnpm-flattened equivalent).
  let dir = here
  for (let i = 0; i < 10; i++) {
    const direct = path.join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if (existsSync(direct)) return direct
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function waitForLiveLock(timeoutMs: number): Promise<DaemonLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    if (lock && await isLockLive(lock)) return lock
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new DaemonClientError('INTERNAL', 'daemon did not start within 5s')
}

/**
 * Print the error and exit with the code the original in-process CLI
 * would have used. Calls `process.exit` — never returns.
 */
export function exitOnClientError(err: unknown): never {
  if (err instanceof DaemonClientError) {
    console.error(err.message)
    process.exit(exitCodeForError(err.code))
  }
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
}
