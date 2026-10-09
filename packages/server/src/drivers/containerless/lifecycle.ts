import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { notifyWorkspaceListChanged } from '#notify'
import { serverLog } from '#log'
import { runHostCheck } from './check'
import { isSshAgentFor, killPids } from './host'
import { tmuxAnswers } from './exec'
import { containerlessJobName, containerlessWorkspacePaths, workspaceHome } from './paths'
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
 * Driver start/stop: recovering workspaces on server start, and noticing when
 * one dies. tmux servers outlive the yaac server, so a new server reads the
 * markers on disk and probes each socket. While running, it holds one idle
 * tmux client per workspace; that client exiting signals the
 * workspace died. The reconcile resync covers a missed event.
 */

/** One idle control client per running workspace: the liveness edge. */
const watches = new Map<string, ChildProcess>()

/** Delay before re-arming a watch whose workspace is still alive. */
const WATCH_REARM_MS = 1_000

/**
 * Rebuild the registry from markers on disk. A marker whose tmux socket does
 * not answer is kept as a dead workspace, not dropped, so the stale reaper
 * can turn its row into a stopped workspace.
 */
async function recoverWorkspaces(): Promise<void> {
  const markers = await readMarkers()
  for (const marker of markers) {
    const alive = await socketAnswers(marker)
    restoreWorkspace(marker, alive, alive
      ? { reason: 'pod-stopped' }
      : {
        reason: 'agent-exited',
        detail: 'the workspace\'s tmux server is no longer running '
          + '(host reboot, or it was killed)',
      })
    if (!alive) await sweepDeadWorkspaceSecrets(marker)
  }
  if (markers.length > 0) {
    const live = listWorkspaces().filter((w) => w.running).length
    serverLog(
      `[server] containerless: recovered ${String(markers.length)} workspace(s), `
      + `${String(live)} still running`,
    )
  }
}

/**
 * Remove a dead workspace's credentials now rather than at stop: the git
 * credential store, and the ssh-agent (not tmux's child, so it survives
 * tmux dying) holding the private key. A restart recreates both.
 */
async function sweepDeadWorkspaceSecrets(marker: WorkspaceMarker): Promise<void> {
  const paths = containerlessWorkspacePaths(
    containerlessJobName(marker.projectId, marker.workspaceId),
  )
  // After a reboot the pid may belong to an unrelated process.
  if (marker.sshAgentPid !== undefined
    && await isSshAgentFor(marker.sshAgentPid, paths.sshAgentSock)) {
    killPids([marker.sshAgentPid], 'SIGTERM')
  }
  const home = workspaceHome(marker.projectId, marker.workspaceId)
  for (const file of [path.join(home, '.git-credentials'), paths.sshAgentSock]) {
    await fs.rm(file, { force: true }).catch((err: unknown) => {
      serverLog(
        `[server] containerless: could not clear ${file} for a dead workspace: ${String(err)}`,
      )
    })
  }
}

function socketAnswers(marker: WorkspaceMarker): Promise<boolean> {
  return tmuxAnswers(containerlessWorkspacePaths(
    containerlessJobName(marker.projectId, marker.workspaceId),
  ).tmuxSock)
}

/**
 * Watch a workspace by holding an output-suppressed tmux control-mode client
 * open. tmux ends its clients when the server dies, so the client's exit
 * signals the workspace is gone. Not `read-only`: from tmux 3.7, a
 * command-line `send-keys` is refused while any read-only client is attached.
 */
function watchWorkspace(workspaceId: string, jobName: string, sinks: DriverSinks): void {
  if (watches.has(workspaceId)) return
  const paths = containerlessWorkspacePaths(jobName)
  const child = spawn('tmux', [
    '-S', paths.tmuxSock, '-C', 'attach-session', '-t', 'yaac',
    '-f', 'ignore-size,no-output',
  ], {
    // stdin must stay an open pipe: a control-mode client exits when its
    // stdin closes, which would look like the workspace dying.
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
 * A watch exited; confirm the workspace did too before marking it dead,
 * since the stale reaper will then kill it. A watch can also end from a
 * failed spawn (EMFILE/EAGAIN) or a user's `tmux detach-client`, so probe
 * the socket once and re-arm the watch if tmux still answers.
 */
async function confirmDown(
  workspaceId: string,
  jobName: string,
  sinks: DriverSinks,
): Promise<void> {
  if (await tmuxAnswers(containerlessWorkspacePaths(jobName).tmuxSock)) {
    // Still alive. Re-arm after a delay so a failing spawn backs off.
    setTimeout(() => {
      if (activeSinks === sinks) watchWorkspace(workspaceId, jobName, sinks)
    }, WATCH_REARM_MS).unref?.()
    return
  }
  forgetPorts(workspaceId)
  const changed = observeLiveness(workspaceId, false, {
    reason: 'agent-exited',
    detail: 'the workspace\'s tmux server exited',
  })
  if (!changed) return
  sinks.workspacesChanged(listWorkspaces())
  sinks.trigger('workspaces')
  notifyWorkspaceListChanged()
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
 * Watch and announce a just-launched workspace (called right after
 * `launch`). With no informer on this substrate, this is how the status
 * watchers learn of it; without it an `acp` workspace would never get its
 * acpd connection.
 */
export function watchNewWorkspace(workspaceId: string, jobName: string): void {
  const sinks = activeSinks
  if (!sinks) return
  watchWorkspace(workspaceId, jobName, sinks)
  sinks.workspacesChanged(listWorkspaces())
}

let activeSinks: DriverSinks | null = null

/** See `WorkspaceDriver.start`. */
export async function startContainerlessDriver(sinks: DriverSinks): Promise<void> {
  activeSinks = sinks

  // Advisory only: the server still serves projects and auth, and a create
  // fails with a clear error.
  const checks = await runHostCheck().catch(() => [])
  for (const c of checks) {
    if (c.status === 'fail') {
      serverLog(`[server] containerless: ${c.name}: ${c.detail}${c.fix ? ` — ${c.fix}` : ''}`)
    }
  }

  await recoverWorkspaces().catch((err: unknown) => {
    serverLog(`[server] containerless: recovery failed: ${String(err)}`)
  })

  // Before the watches, so recovery does not race the first events.
  try {
    await sinks.recover()
  } catch (err) {
    serverLog(`[server] runtime recovery failed: ${String(err)}`)
  }

  sinks.workspacesChanged(listWorkspaces())
  syncWatches(sinks)
  startPortSweep(() => notifyWorkspaceListChanged())
  sinks.attached()
}

/** See `WorkspaceDriver.stop`. */
export function stopContainerlessDriver(): void {
  stopPortSweep()
  // Only the watches stop; workspaces keep running for the next server.
  for (const child of watches.values()) child.kill()
  watches.clear()
  activeSinks = null
}

/** See `WorkspaceDriver.release`. Nothing to release. */
export function releaseContainerlessDriver(): void {
  /* nothing held */
}
