/**
 * Tracking and reaping of the `podman build`/`push` processes that `yaac
 * cluster install` spawns. An install killed mid-build leaves podman running,
 * and the next install would start a second build of the same tag, fighting
 * over the layer cache and store lock.
 *
 * So each spawn is recorded in `<data dir>/host-podman.json`, and
 * `reapOrphanedPodmanProcs` kills any still alive at the start of the next
 * install. All best-effort: failures here never fail a build.
 */
import { type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { clientLocalPath } from '@yaac/shared/paths'
import { serverLog } from '#log'
import { runStreamingProcess } from './streaming-proc'
import { execFileAsync } from './runtime'

/** How long a reaped orphan gets to honour SIGTERM before SIGKILL. */
const TERM_POLL_MS = 200
const TERM_GRACE_TICKS = 25

/** Client-local: host pids, meaningful only on the machine that ran the
 *  install. */
const STATE_FILENAME = 'host-podman.json'

interface ProcRecord {
  pid: number
  /** Content-hash tag being produced; guards against pid reuse at reap. */
  tag: string
  /** podman subcommand (`build` / `push`), for the log line. */
  verb: string
}

const live = new Map<number, { child: ChildProcess; record: ProcRecord }>()

function statePath(): string {
  return clientLocalPath(STATE_FILENAME)
}

/** Rewrite the state file from the live set. Synchronous, so a SIGKILL
 *  cannot orphan a pid before it is recorded. */
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
  /**
   * Optional silence budget, the primary bound for a build (see
   * streaming-proc.ts). Omit where only the hard cap makes sense.
   */
  idleTimeoutMs?: number
}

/** Run a podman command, logging its output and recording its pid while
 *  it runs. Resolves on exit 0, rejects otherwise. */
export function runTrackedPodman(args: string[], opts: TrackedPodmanOpts): Promise<void> {
  const verb = args[0] ?? 'podman'
  let child: ChildProcess | null = null
  const forget = (): void => {
    if (child?.pid === undefined || !live.delete(child.pid)) return
    persist()
  }
  return runStreamingProcess('podman', args, {
    logPrefix: opts.logPrefix,
    onLog: opts.onLog,
    idleTimeoutMs: opts.idleTimeoutMs,
    timeoutMs: opts.timeoutMs,
    label: `podman ${verb}`,
    onSpawn: (spawned) => {
      child = spawned
      if (spawned.pid === undefined) return
      live.set(spawned.pid, { child: spawned, record: { pid: spawned.pid, tag: opts.tag, verb } })
      persist()
    },
    // On `exit`, not `close`: a grandchild can hold the pipes open long after
    // the pid is gone and possibly reused.
    onExit: forget,
  })
}

/** Kill podman builds/pushes a previous install left running, then clear
 *  the record. Must run before any build starts. */
export async function reapOrphanedPodmanProcs(): Promise<void> {
  let records: unknown
  try {
    records = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
  } catch (err) {
    // Missing or unreadable file; a bad one is rewritten below.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    persist()
    return
  }

  if (Array.isArray(records)) {
    for (const rec of records as ProcRecord[]) {
      // pid 0 or negative would signal whole process groups.
      if (!Number.isInteger(rec?.pid) || rec.pid <= 0) continue
      if (typeof rec.tag !== 'string') continue
      if (!await isOrphanedPodman(rec)) continue
      serverLog(
        `[podman] reaping orphaned ${rec.verb} of ${rec.tag} `
        + `(pid ${rec.pid}) left by a previous install`,
      )
      await terminate(rec)
    }
  }

  // Only after every kill, so an install that dies meanwhile leaves the rest
  // for the next sweep. Rewrite rather than unlink, keeping any concurrent
  // build's record.
  persist()
}

/** Whether a live pid is still our podman process (its command line has
 *  the recorded tag), not a reused pid. */
async function isOrphanedPodman(rec: ProcRecord): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(rec.pid), '-o', 'args='])
    return stdout.includes('podman') && stdout.includes(rec.tag)
  } catch {
    // `ps` fails when the pid is gone.
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
  // Still alive after the grace period: SIGKILL, but only after checking the
  // pid is still ours.
  if (!await isOrphanedPodman(rec)) return
  try {
    process.kill(rec.pid, 'SIGKILL')
  } catch {
    // raced with its own exit
  }
}

/** Test helper: forget the tracked set without signalling. */
export function _clearTrackedPodmanProcsForTests(): void {
  live.clear()
}
