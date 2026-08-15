import { spawn, type ChildProcess } from 'node:child_process'
import { notifyWorktreeListChanged } from '#notify'
import { serverLog } from '#log'
import { runHostCheck } from './check'
import { runHost } from './host'
import { containerlessJobName, containerlessWorkspacePaths } from './paths'
import {
  listWorkspaces,
  observeLiveness,
  readMarkers,
  restoreWorkspace,
  type WorkspaceMarker,
} from './registry'
import { forgetPorts, startPortSweep, stopPortSweep } from './ports'
import type { DriverSinks } from '#drivers/contract'

/**
 * This driver's attach and detach: what it re-learns when a server starts,
 * and how it notices a workspace dying while one runs.
 *
 * Both answers follow from the premise that a tmux server outlives the yaac
 * server that started it. Nothing else on a bare host records that a
 * workspace exists, so a fresh server reads the markers it wrote last time
 * and probes each socket; and once running, it holds one idle read-only tmux
 * client per workspace, whose exit IS the death edge. That is a push, not a
 * poll — the reconcile resync is the backstop for an edge that gets lost,
 * exactly as it is for the pod driver's informers.
 */

/** One idle control client per running workspace: the liveness edge. */
const watches = new Map<string, ChildProcess>()

/** How long to wait before re-arming a watch whose workspace turned out
 *  to be alive — enough that a failing spawn backs off. */
const WATCH_REARM_MS = 1_000

/**
 * Re-learn the workspaces from the markers on disk.
 *
 * A marker whose socket still answers is a running workspace, recovered
 * whole — its agents have been running this entire time. One whose socket
 * does not is recorded as a DEAD workspace rather than dropped: the stale
 * reaper is what turns a dead runtime into a stopped worktree row, and it
 * can only do that for a workspace the driver still reports. Dropping it
 * here would leave a row claiming to be running with nothing to reap it.
 */
async function recoverWorkspaces(): Promise<void> {
  const markers = await readMarkers()
  for (const marker of markers) {
    const alive = await socketAnswers(marker)
    restoreWorkspace(marker, alive, alive
      ? { reason: 'pod-stopped' }
      : {
        reason: 'agent-exited',
        detail: 'the worktree\'s tmux server is no longer running '
          + '(host reboot, or it was killed)',
      })
  }
  if (markers.length > 0) {
    const live = listWorkspaces().filter((w) => w.running).length
    serverLog(
      `[server] containerless: recovered ${String(markers.length)} worktree(s), `
      + `${String(live)} still running`,
    )
  }
}

async function socketAnswers(marker: WorkspaceMarker): Promise<boolean> {
  const paths = containerlessWorkspacePaths(
    containerlessJobName(marker.projectSlug, marker.worktreeId),
  )
  try {
    await runHost(['tmux', '-S', paths.tmuxSock, 'has-session', '-t', 'yaac'], {
      timeoutMs: 5_000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Watch one workspace by holding a control-mode client open against it.
 *
 * Read-only and output-suppressed, so it costs an idle process and no
 * traffic; what it is FOR is the exit. tmux ends every client when its
 * server dies, so the `close` here is the substrate telling us the
 * workspace is gone — the edge a host has no informer to provide.
 */
function watchWorkspace(workspaceId: string, jobName: string, sinks: DriverSinks): void {
  if (watches.has(workspaceId)) return
  const paths = containerlessWorkspacePaths(jobName)
  const child = spawn('tmux', [
    '-S', paths.tmuxSock, '-C', 'attach-session', '-t', 'yaac',
    '-f', 'read-only,ignore-size,no-output',
  ], {
    // stdin MUST be a pipe we hold open, even though nothing is ever
    // written to it: a control-mode client exits as soon as its stdin
    // closes, so an inherited-or-ignored stdin makes this watch die
    // instantly — and its exit is precisely what means "the workspace is
    // gone". Output is discarded (`no-output` already suppresses the
    // stream's bulk); what this process is FOR is its exit.
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  watches.set(workspaceId, child)

  const down = (): void => {
    if (watches.get(workspaceId) !== child) return
    watches.delete(workspaceId)
    void confirmDown(workspaceId, jobName, sinks)
  }
  child.on('close', down)
  child.on('error', down)
}

/**
 * A watch exited. Decide whether that means the workspace did.
 *
 * It usually does — tmux ends every client when its server dies — but not
 * always, and the two cases are worth telling apart because the consequence
 * is destructive: a `running: false` here is the evidence the stale reaper
 * acts on, and nothing re-probes afterwards (a dead handle is skipped by the
 * liveness probes and served as-is from the registry), so the next pass
 * issues a real `kill-server` against live agents mid-turn.
 *
 * What can end a watch with tmux alive: a spawn that failed under fd or
 * process pressure (EMFILE/EAGAIN), and a user's `tmux detach-client`
 * landing on this client. So the socket is probed once before the edge is
 * allowed to stick — it is cheap, and the path is already in hand. If it
 * answers, the watch is re-armed instead. The k8s driver gets this for free:
 * its equivalent evidence is an authoritative pod listing, not one process
 * exit.
 */
async function confirmDown(
  workspaceId: string,
  jobName: string,
  sinks: DriverSinks,
): Promise<void> {
  const paths = containerlessWorkspacePaths(jobName)
  try {
    await runHost(['tmux', '-S', paths.tmuxSock, 'has-session', '-t', 'yaac'], {
      timeoutMs: 5_000,
    })
    // Still there: the watch died, not the workspace. Re-armed after a beat
    // so a persistently failing spawn backs off instead of hot-looping.
    setTimeout(() => {
      if (activeSinks === sinks) watchWorkspace(workspaceId, jobName, sinks)
    }, WATCH_REARM_MS).unref?.()
    return
  } catch {
    // Really gone — fall through to reporting it.
  }
  forgetPorts(workspaceId)
  const changed = observeLiveness(workspaceId, false, {
    reason: 'agent-exited',
    detail: 'the worktree\'s tmux server exited',
  })
  if (!changed) return
  // The whole set, never a delta — the receiver holds no state it would
  // have to reconcile (see `DriverSinks.workspacesChanged`).
  sinks.workspacesChanged(listWorkspaces())
  sinks.trigger('workspaces')
  notifyWorktreeListChanged()
}

/**
 * How many workspaces this substrate is still running, answered WITHOUT
 * attaching — from the markers on disk and a probe of each socket.
 *
 * For the composition root, which has to ask before it registers a
 * different driver: a tmux server is invisible to every other substrate,
 * and once a k8s pass has reaped the row and removed the state dir the
 * marker lived in, nothing can ever find it again. The agents keep running
 * as the user, holding their checkouts, unmanageable.
 */
export async function liveWorkspaceCount(): Promise<number> {
  const markers = await readMarkers().catch(() => [])
  let live = 0
  for (const marker of markers) {
    if (await socketAnswers(marker)) live++
  }
  return live
}

/** Bring the watch set in line with the workspaces we believe are running. */
function syncWatches(sinks: DriverSinks): void {
  const running = new Set<string>()
  for (const handle of listWorkspaces()) {
    if (!handle.running) continue
    running.add(handle.workspaceId)
    watchWorkspace(handle.workspaceId, handle.jobName, sinks)
  }
  for (const [id, child] of watches) {
    if (running.has(id)) continue
    watches.delete(id)
    child.kill()
  }
}

/**
 * Ask for a watch of a just-launched workspace, without waiting for a
 * sweep. Called by the assembly right after `launch`.
 *
 * Announcing it is the other half, and the half nothing else here does. The
 * pod driver gets it free — its informer reports the new pod, and everything
 * that watches workspaces (the status watcher pool above all) learns about it
 * from that event. This substrate has no informer: the set is announced when
 * the driver starts and when a workspace dies, so without this a worktree
 * created since startup is one nothing observes until the next server start.
 * A `tui` worktree merely goes unwatched — its status stops tracking the
 * agent — while an `acp` one never gets a connection at all, so nobody dials
 * acpd, the handshake never runs, and the worktree has no conversation and no
 * chat pane for as long as this server lives.
 */
export function watchNewWorkspace(workspaceId: string, jobName: string): void {
  const sinks = activeSinks
  if (!sinks) return
  watchWorkspace(workspaceId, jobName, sinks)
  // The whole set, never a delta — the receiver holds no state it would have
  // to reconcile (see `DriverSinks.workspacesChanged`).
  sinks.workspacesChanged(listWorkspaces())
}

let activeSinks: DriverSinks | null = null

/** See `WorktreeDriver.start`. */
export async function startContainerlessDriver(sinks: DriverSinks): Promise<void> {
  activeSinks = sinks

  // Advisory, never fatal — the same posture the pod driver takes toward a
  // cluster it cannot reach. A server with no tmux still serves projects and
  // auth; it is the first CREATE that has to fail, with something better to
  // say than a spawn error.
  const checks = await runHostCheck().catch(() => [])
  for (const c of checks) {
    if (c.status === 'fail') {
      serverLog(`[server] containerless: ${c.name}: ${c.detail}${c.fix ? ` — ${c.fix}` : ''}`)
    }
  }

  await recoverWorkspaces().catch((err: unknown) => {
    serverLog(`[server] containerless: recovery failed: ${String(err)}`)
  })

  // The substrate is usable and nothing is watching yet — the caller's
  // moment to rebuild what the last server left running. Before the watches,
  // so recovery never races the first edges.
  try {
    await sinks.recover()
  } catch (err) {
    serverLog(`[server] runtime recovery failed: ${String(err)}`)
  }

  sinks.workspacesChanged(listWorkspaces())
  syncWatches(sinks)
  startPortSweep(() => notifyWorktreeListChanged())
  sinks.attached()
}

/** See `WorktreeDriver.stop`. */
export function stopContainerlessDriver(): void {
  stopPortSweep()
  // Only the WATCHES go down. Every workspace's tmux server keeps running,
  // which is the entire point: a `yaac server restart` must not stop
  // anyone's agent, and the next server recovers them from their markers.
  for (const child of watches.values()) child.kill()
  watches.clear()
  activeSinks = null
}

/** See `WorktreeDriver.release`. Nothing is borrowed from the host that
 *  `stop` did not already give back: no listeners, no tunnels, no relay. */
export function releaseContainerlessDriver(): void {
  /* nothing held */
}
