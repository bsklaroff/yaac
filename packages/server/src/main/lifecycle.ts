import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readBuildId } from '@yaac/shared/build-id'
import { readLock, removeLock } from '@yaac/shared/lock'
import {
  isLockLive,
  isSameHostLock,
  type ServerLock,
} from '@yaac/shared/server-lock-file'
import { ensureDataDir } from '@yaac/shared/project-paths'
import { serverLogPath } from '@yaac/shared/paths'
import { waitFor } from '#lib/wait-for'
import { preflightHostTor, torCoverageWarning } from '#main/server-run'
import { env } from '@yaac/shared/env'
import { assertHostServerAllowed } from '#main/driver-choice'
import { registerServer } from '@yaac/shared/server-config'
import { readInstallRecord } from '@yaac/shared/install-record'
import type { AccessMode, LocalServerStatus } from '@yaac/shared/types'

/**
 * The access flags of `yaac server start|restart` (docs/remote-hosting.md
 * "Access modes"): `tailnet` is the MagicDNS name `tailscale serve` fronts
 * the server at, and `owner` the login a switch from local gives the
 * install to.
 */
export interface ServerAccessOptions {
  tailnet?: string
  owner?: string
}

/**
 * Entry point for `yaac server start`.
 *
 * - If a server is already running with the matching buildId and access
 *   mode, no-op.
 * - If running with a different buildId or mode, throw — the user should
 *   `yaac server restart`.
 * - Otherwise clean any stale lock, spawn `yaac server run` detached, and
 *   wait for it to be ready, or to report that it refused the access mode
 *   (then stop it and throw the reason).
 */
export async function startServer(opts: ServerAccessOptions = {}, keepSelection = false): Promise<void> {
  const tailnet = tailnetHost(opts)
  const mode: AccessMode = tailnet === undefined ? 'local' : 'tailnet'
  const origin = (port: number): string => tailnet === undefined ? `http://127.0.0.1:${port}` : `https://${tailnet}`
  await preflightHostTor()
  await ensureDataDir()
  // Check before spawning: a detached child that refuses dies before its
  // log exists, leaving only an unexplained ready-poll timeout.
  await assertHostServerAllowed()
  const cliBuildId = await readBuildId()

  const existing = await readLock()
  if (existing && await isLockLive(existing)) {
    const running = (await health(existing.port))?.access
    if (existing.buildId === cliBuildId && running === 'tailnet' && mode === 'local') {
      throw new Error(
        'yaac server is running in tailnet mode, which cannot switch back to local. '
        + 'Start it with: yaac server start --tailnet <host>',
      )
    }
    if (existing.buildId === cliBuildId && running === 'local' && mode === 'tailnet') {
      throw new Error(
        `yaac server is running in local mode. Switch it with: yaac server restart --tailnet ${tailnet} `
        + '--owner <login> (the tailnet login that will own its projects and settings)',
      )
    }
    if (existing.buildId === cliBuildId) {
      console.error(`[yaac] server already running pid=${existing.pid} port=${existing.port}`)
      // Register anyway: the running server may be a foreground
      // `yaac server run`, which registers nothing.
      await registerLocalServer(origin(existing.port), keepSelection)
      return
    }
    throw new Error(
      'yaac server is running an outdated version '
      + `(server buildId ${existing.buildId}, CLI buildId ${cliBuildId}). `
      + 'Restart it with: yaac server restart',
    )
  }

  // A stale lock (dead pid or silent port). Clearing it keeps the
  // wait-for-new-lock poll simple.
  if (existing) await removeLock()

  await spawnServerDetached({
    YAAC_ACCESS_MODE: mode,
    YAAC_ACCESS_OWNER: opts.owner,
    // A local server keeps whatever the shell sets: a nested server needs
    // the outer forward's name, and a local install refuses serve anyway.
    // eslint-disable-next-line no-process-env -- the child's env, not a setting read here
    YAAC_ALLOWED_HOSTS: tailnet ?? process.env.YAAC_ALLOWED_HOSTS,
  })
  // Wait for readiness, not just liveness: /health answers before the DB
  // opens and first-boot migrations block the event loop for seconds. 30s
  // covers a cold-start migration with headroom.
  const fresh = await waitForReadyLock(30_000)
  if (fresh.buildId !== cliBuildId) {
    throw new Error(
      `server buildId ${fresh.buildId} does not match CLI buildId ${cliBuildId}`,
    )
  }
  await registerLocalServer(origin(fresh.port), keepSelection)
  const torPrefix = env.useTor ? '(using tor) ' : ''
  console.error(`[yaac] ${torPrefix}server started pid=${fresh.pid} port=${fresh.port}`)
  // A host server is always containerless (`#main/driver-choice`). Repeat
  // the warning here, since the child only wrote it to its log file.
  const torGap = torCoverageWarning('containerless')
  if (torGap !== undefined) console.error(`[yaac] WARNING: ${torGap}`)
}

/**
 * Register the host server in `server.json` and record its data dir as a
 * containerless install, the same registration `yaac cluster install` does
 * for the Deployment. On failure the server keeps running but clients
 * cannot find it; rerunning the command fixes that.
 */
async function registerLocalServer(origin: string, keepSelection: boolean): Promise<void> {
  try {
    await registerServer(origin, 'containerless', { keepSelection })
  } catch (err) {
    console.error(
      `[yaac] WARNING: the server is up, but this machine could not be pointed at it: ${
        err instanceof Error ? err.message : String(err)
      }\n    Commands will report no server selected until \`yaac server start\` succeeds at this step.`,
    )
  }
}

/**
 * Entry point for `yaac server stop`. SIGTERMs the running server and
 * waits for its shutdown handler to unlink the lock. Force-removes the
 * lock if the server doesn't exit within 3s.
 */
export async function stopServer(): Promise<void> {
  const existing = await readLock()
  if (!existing) {
    console.error('[yaac] server is not running')
    return
  }
  if (!await isLockLive(existing)) {
    await removeLock()
    console.error(`[yaac] removed stale lock (pid ${existing.pid})`)
    return
  }

  if (!isSameHostLock(existing)) {
    // A live lock from another host belongs to an in-cluster server
    // (docs/server-in-cluster.md) on a data dir that records no driver.
    // Removing the lock would make the pod exit and restart, and would let
    // a later `yaac server start` add a second writer, so change nothing.
    console.error(
      `[yaac] this data dir's server runs in a cluster (lock held by `
      + `${existing.host ?? 'another host'}, lease still being renewed), so `
      + 'there is no host server to stop.\n'
      + '    Stop it with `yaac cluster stop`, or scale it by hand:\n'
      + '    kubectl -n <namespace> scale deployment/yaac-server --replicas=0',
    )
    process.exitCode = 1
    return
  }

  try {
    process.kill(existing.pid, 'SIGTERM')
  } catch {
    // Already gone; the lock is still cleared below.
  }

  // Shutdown takes up to ~6s under load (3s loop drain + 3s server close),
  // so allow headroom before reporting a force-removal.
  const released = await waitFor(async () => {
    const cur = await readLock()
    return !cur || cur.pid !== existing.pid
  }, { timeoutMs: 10_000, intervalMs: 50 })
  if (released) {
    console.error(`[yaac] server stopped (pid ${existing.pid})`)
    return
  }
  // The old process is gone or wedged; remove its lock ourselves.
  const cur = await readLock()
  if (cur && cur.pid === existing.pid) await removeLock()
  console.error(`[yaac] force-removed stale lock (pid ${existing.pid})`)
}

/**
 * Entry point for `yaac server restart`. Stops any running server, then
 * starts a fresh one, leaving the selection on another server alone.
 */
export async function restartServer(opts: ServerAccessOptions = {}): Promise<void> {
  tailnetHost(opts)
  await stopServer()
  await startServer(opts, true)
}

/**
 * Entry point for `yaac server status` and `yaac cluster status`: whether
 * this data dir's server runs, and on which build. The lock answers for a
 * host server and for a kind install's pod alike, since both keep it in
 * their data dir.
 */
export async function serverStatus(): Promise<LocalServerStatus> {
  const cfg = await readInstallRecord()
  const base = { driver: cfg?.driver ?? null, cliBuildId: await readBuildId() }
  if (cfg?.byo) return { ...base, running: null, serverBuildId: null }
  const lock = await readLock()
  const live = lock !== null && await isLockLive(lock)
  return { ...base, running: live, serverBuildId: live ? lock.buildId : null }
}

/** Check the access flags; returns the lowercased tailnet name. */
function tailnetHost(opts: ServerAccessOptions): string | undefined {
  if (opts.owner !== undefined && opts.tailnet === undefined) {
    throw new Error(
      '--owner names the tailnet login that claims this install as it switches to tailnet '
      + 'mode, so it needs --tailnet <host> (docs/remote-hosting.md "Access modes").',
    )
  }
  if (opts.tailnet === undefined) return undefined
  const host = opts.tailnet.trim().toLowerCase()
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    throw new Error(
      '--tailnet takes the bare MagicDNS name tailscale serve fronts this machine at, '
      + `e.g. srv.<tailnet>.ts.net (got "${opts.tailnet}").`,
    )
  }
  return host
}

/**
 * Relaunch ourselves as `yaac server run`, detached. Under tsx (dev) the
 * entry is the `.ts` source, so the child goes through tsx's CLI to set up
 * the loader again.
 */
async function spawnServerDetached(overrides: Record<string, string | undefined>): Promise<void> {
  const entry = process.argv[1] ?? ''
  const loader = entry.endsWith('.ts') ? [createRequire(import.meta.url).resolve('tsx/cli')] : []
  // eslint-disable-next-line no-process-env -- forward the full host env to the detached server subprocess
  const childEnv = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  const child = spawn(process.execPath, [...loader, entry, 'server', 'run'], {
    detached: true,
    stdio: 'ignore',
    env: childEnv,
  })
  child.unref()
  // If the spawn itself fails immediately (e.g. ENOENT), surface it.
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    // A detached child gives no success signal; wait a tick and let the
    // lock poll catch later failures.
    setTimeout(resolve, 50)
  })
}

async function waitForReadyLock(timeoutMs: number): Promise<ServerLock> {
  let refused: string | undefined
  const lock = await waitFor(async () => {
    const cur = await readLock()
    if (!cur || !await isLockLive(cur)) return undefined
    const body = await health(cur.port)
    refused = body?.refused
    return body?.ready === true || refused !== undefined ? cur : undefined
  }, { timeoutMs, intervalMs: 100 })
  if (refused !== undefined) {
    await stopServer()
    throw new Error(`the server refused to start: ${refused}`)
  }
  if (lock) return lock
  throw new Error(`server did not become ready within ${Math.round(timeoutMs / 1000)}s`)
}

interface Health { ready?: boolean; access?: AccessMode | null; refused?: string }

/** The host server's `/health`, or undefined when it does not answer. */
async function health(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
    return res.ok ? await res.json() as Health : undefined
  } catch {
    return undefined
  }
}

export interface ServerLogsOptions {
  /** Keep printing as new lines are appended to the log file. */
  follow?: boolean
  /** Print only the last N lines (before following, if combined with follow). */
  lines?: number
}

/**
 * Entry point for `yaac server logs`: prints `serverLogPath()` via `tail`,
 * using only flags shared by BSD and GNU tail (macOS and Linux).
 *
 * - No options: the whole file (`tail -n +1`).
 * - `--lines N`: the last N lines.
 * - `--follow`: keep printing (`tail -F`, which also handles the file
 *   appearing later or being replaced).
 */
export async function serverLogs(opts: ServerLogsOptions = {}): Promise<void> {
  const logPath = serverLogPath()

  if (!existsSync(logPath)) {
    if (!opts.follow) {
      console.error(`[yaac] no server log at ${logPath}`)
      return
    }
    console.error(`[yaac] no server log at ${logPath} yet — waiting for it`)
  }

  const args = opts.follow ? ['-F'] : []
  // Clamp N to 0: a negative N would put tail into last-|N|-lines mode.
  args.push('-n', opts.lines !== undefined ? String(Math.max(0, opts.lines)) : '+1')
  args.push(logPath)

  // Drop stderr: the missing-file case is reported above, and `tail -F`
  // prints retry/rotation notices.
  const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.pipe(process.stdout, { end: false })

  await new Promise<void>((resolve, reject) => {
    // Forward Ctrl-C so tail dies with us instead of being orphaned.
    const onSigint = (): void => { child.kill('SIGINT') }
    process.on('SIGINT', onSigint)
    child.on('error', (err) => {
      process.off('SIGINT', onSigint)
      reject(err)
    })
    child.on('close', (code, signal) => {
      process.off('SIGINT', onSigint)
      if (code === 0 || signal === 'SIGINT') resolve()
      else reject(new Error(`tail exited with ${signal ?? `code ${code}`}`))
    })
  })
}
