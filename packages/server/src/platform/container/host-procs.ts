/**
 * Tracking and reaping for the podman child processes yaac spawns on the
 * host — `podman build` and `podman push`.
 *
 * These outlive the server by default. Nothing holds a handle to them, so a
 * SIGTERM'd (let alone crashed) server leaves a live `podman build`
 * reparented to PID 1. Podman only commits the tag when the build finishes,
 * so the next server's `imageExists` check misses and it starts a *second*
 * build of the same tag — two podman processes fighting over the shared
 * layer cache and the image-store lock, for the slowest layers we have.
 *
 * The builder-pod half of a trust-split build is already covered:
 * `reconcileBuilderPodGc` deletes any builder pod created before this
 * process started. This is the host-side equivalent, and it needs a durable
 * record because a host pid carries no label to select on. Every tracked
 * spawn is written to `<data dir>/host-podman.json` before it can be
 * orphaned; `reapOrphanedPodmanProcs` reads that file once at boot — under
 * the data-dir lock, so its pids can only belong to a dead predecessor — and
 * kills whatever is still alive. `killTrackedPodmanProcs` is the graceful
 * half, called from the shutdown handler so a normal restart leaves nothing
 * to reap in the first place.
 *
 * Every part of this is best-effort: a failed record write, a missing file
 * or a failed kill degrades to the old behaviour (one duplicate build), so
 * nothing here is allowed to fail a build.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { serverLocalPath } from '@yaac/shared/paths'
import { serverLog, pipeToServerLog } from '#log'
import { execFileAsync } from './runtime'

/** How long a reaped orphan gets to honour SIGTERM before SIGKILL. */
const TERM_POLL_MS = 200
const TERM_GRACE_TICKS = 25

/**
 * SERVER-LOCAL: host pids, meaningful only to the server process that
 * spawned them and only on the machine it runs on.
 */
const STATE_FILENAME = 'host-podman.json'

interface ProcRecord {
  pid: number
  /** Content-hash tag being produced — the pid-reuse guard at reap time. */
  tag: string
  /** podman subcommand (`build` / `push`), for the log line. */
  verb: string
}

const live = new Map<number, { child: ChildProcess; record: ProcRecord }>()

function statePath(): string {
  return serverLocalPath(STATE_FILENAME)
}

/**
 * Rewrite the state file from the live set. Synchronous on purpose: an
 * async write leaves a window in which a SIGKILL orphans a pid that was
 * never recorded, which is exactly the case this file exists for. The
 * payload is a handful of records, and it is written at most twice per
 * build.
 */
function persist(): void {
  const p = statePath()
  const tmp = `${p}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify([...live.values()].map((e) => e.record)))
    fs.renameSync(tmp, p)
  } catch (err) {
    serverLog(`[podman] could not record host build pids: ${String(err)}`)
  }
}

export interface TrackedPodmanOpts {
  /** Content-hash tag this invocation produces. */
  tag: string
  /** Prefix for the process's stdout/stderr lines, e.g. `[build <tag>] `. */
  logPrefix: string
  onLog?: (line: string) => void
  /** Hard cap on the run. */
  timeoutMs: number
}

/**
 * Run a podman command, piping its output to the server log and recording
 * its pid for the duration so both the shutdown handler and the next
 * server's boot sweep can abort it. Resolves on exit 0, rejects otherwise.
 */
export function runTrackedPodman(args: string[], opts: TrackedPodmanOpts): Promise<void> {
  const verb = args[0] ?? 'podman'
  return new Promise<void>((resolve, reject) => {
    const child = spawn('podman', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs,
    })
    if (child.pid !== undefined) {
      live.set(child.pid, { child, record: { pid: child.pid, tag: opts.tag, verb } })
      persist()
    }
    pipeToServerLog(child.stdout, opts.logPrefix, opts.onLog)
    pipeToServerLog(child.stderr, opts.logPrefix, opts.onLog)

    const forget = (): void => {
      if (child.pid === undefined || !live.delete(child.pid)) return
      persist()
    }
    child.on('close', (code) => {
      forget()
      if (code === 0) resolve()
      else reject(new Error(`podman ${verb} exited with code ${code}`))
    })
    child.on('error', (err) => {
      forget()
      reject(err)
    })
  })
}

/**
 * Abort every tracked podman process. Called from the shutdown handler, so
 * a restart never hands its successor a half-finished build to duplicate.
 *
 * SIGTERM rather than SIGKILL: podman tears down the in-progress build
 * container and releases the image-store lock on its way out. We don't wait
 * for that — the shutdown path is time-bounded, and a podman still cleaning
 * up exits on its own without ever committing the tag. The state file is
 * deliberately left in place; the next boot's sweep is the only thing that
 * clears it, after confirming each pid is actually gone.
 */
export function killTrackedPodmanProcs(): void {
  if (live.size === 0) return
  serverLog(`[podman] aborting ${live.size} in-flight host process(es)`)
  for (const { child } of live.values()) {
    try {
      child.kill('SIGTERM')
    } catch {
      // already exited
    }
  }
  live.clear()
}

/**
 * Kill any podman build/push left behind by a previous server, then clear
 * the record. Must run before anything can start a build — the whole point
 * is that the orphan dies before the new server decides the tag is missing
 * and rebuilds it.
 *
 * Safe to call unconditionally at boot: the data-dir lock is already held,
 * so every pid in the file belongs to a server that is gone.
 */
export async function reapOrphanedPodmanProcs(): Promise<void> {
  let records: unknown
  try {
    records = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
  } catch (err) {
    // No file at all (first run, or a clean shutdown that never spawned
    // one) — nothing to do, and nothing to write. A torn or garbage file
    // lands here too, and does get rewritten below, so a bad file isn't
    // re-read on every boot from now on.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    persist()
    return
  }

  if (Array.isArray(records)) {
    for (const rec of records as ProcRecord[]) {
      // `process.kill(0, …)` signals this server's own process group and
      // `process.kill(-n, …)` signals all of group n, so a file a crashed
      // writer left in any state must not reach terminate() on the
      // strength of `ps` alone.
      if (!Number.isInteger(rec?.pid) || rec.pid <= 0) continue
      if (typeof rec.tag !== 'string') continue
      if (!await isOrphanedPodman(rec)) continue
      serverLog(
        `[podman] reaping orphaned ${rec.verb} of ${rec.tag} `
        + `(pid ${rec.pid}) left by a previous server`,
      )
      await terminate(rec)
    }
  }

  // Cleared only once every kill is done: a wedged orphan holds the loop
  // above for the full grace period, and a server that dies in that window
  // must leave the remaining entries on disk for the next boot. Re-running
  // the sweep over them is harmless — `isOrphanedPodman` re-verifies each
  // pid and re-killing a dead one is a no-op. Rewriting the live set rather
  // than unlinking means a build that somehow started alongside the sweep
  // keeps its record instead of losing it.
  persist()
}

/**
 * Guard against pid reuse: between the previous server's death and this
 * boot the OS may have handed the pid to something else. A live process
 * only counts as ours when its command line is a podman invocation carrying
 * the exact content-hash tag we recorded — a false positive would need the
 * reused pid to also be a podman build of the same tag.
 */
async function isOrphanedPodman(rec: ProcRecord): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(rec.pid), '-o', 'args='])
    return stdout.includes('podman') && stdout.includes(rec.tag)
  } catch {
    // `ps` exits non-zero when the pid is gone — the common case after a
    // graceful shutdown, which SIGTERMs its children on the way out.
    return false
  }
}

async function terminate(rec: ProcRecord): Promise<void> {
  try {
    process.kill(rec.pid, 'SIGTERM')
  } catch {
    return
  }
  for (let i = 0; i < TERM_GRACE_TICKS; i++) {
    await new Promise((r) => setTimeout(r, TERM_POLL_MS))
    try {
      process.kill(rec.pid, 0)
    } catch {
      return
    }
  }
  // Wedged past the grace period (a RUN step swallowing SIGTERM). A leaked
  // build container is far cheaper than an orphan holding the image-store
  // lock against every build this server is about to start.
  //
  // Re-identify first: the liveness probe above only proves *some* process
  // holds the pid, so over the whole grace period it can be a reused pid
  // rather than our wedged build. SIGKILL is the one signal with no
  // recovery, so it is spent only on a process `ps` still calls ours.
  if (!await isOrphanedPodman(rec)) return
  try {
    process.kill(rec.pid, 'SIGKILL')
  } catch {
    // raced with its own exit
  }
}

/** Test-only: forget the tracked set without signalling anything. */
export function _clearTrackedPodmanProcsForTests(): void {
  live.clear()
}
