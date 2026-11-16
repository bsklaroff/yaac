import fs from 'node:fs/promises'
import path from 'node:path'
import { nodeLocalPath, nodeLocalProjectPath } from '@yaac/shared/project-paths'
import { serverLog } from '#lib/log'
import { shellQuote } from '#lib/shell'
import { waitFor } from '@yaac/shared/wait-for'
import { cgroupDir, cgroupPids, descendantPids, isSshAgentFor, killPids, livePids, processTable, runHost } from './host'
import { tmuxAnswers } from './exec'
import { dropWorkspace } from './lifecycle'
import {
  containerlessWorkspacePaths,
  containerlessStateDir,
  workspaceSliceName,
} from './paths'
import {
  cgroupOf,
  findWorkspace,
  removeMarker,
  sshAgentPidOf,
  tmuxPidOf,
} from './registry'
import type { NodeLocalLiveSet, TeardownTarget } from '#drivers/contract'

/**
 * Taking a workspace down: `kill-server` (tmux SIGHUPs every pane), then
 * whatever the workspace started that is still running, the ssh-agent, and
 * the marker.
 *
 * What is still running is read from the workspace's cgroup, where the
 * launch got it one (`launchWorkspace`). That holds every process the
 * workspace started, however it detached: a dev server that double-forked
 * and would hold its port forever, a tmux server of its own, a yaac server
 * and its workspaces. Without one, `destroyWorkspace` finds only what was
 * still under the tmux server when the stop began
 * (docs/containerless-driver.md).
 */

/** How long to wait for the tmux server to exit, then for what it left
 *  behind to act on SIGTERM. */
const CONFIRM_TIMEOUT_MS = 10_000

/** How long to wait for what ignored SIGTERM to die of SIGKILL. */
const KILL_TIMEOUT_MS = 5_000

const POLL_MS = 200

/**
 * The cgroup holding a workspace's processes, or undefined when teardown
 * must do without: the launch recorded none, the one recorded is not a
 * cgroup named for this workspace of this install (a copied data dir's
 * markers name the original's), or this server cannot tell that it is
 * outside it. A server started from one of the workspace's own panes is
 * inside.
 */
function workspaceCgroup(workspaceId: string): string | undefined {
  const dir = cgroupOf(workspaceId)
  const own = cgroupDir()
  if (dir === undefined || own === null) return undefined
  if (path.resolve(dir) !== dir || !dir.startsWith('/sys/fs/cgroup/')) return undefined
  if (!path.basename(dir).endsWith(`${workspaceSliceName(workspaceId)}.slice`)) return undefined
  return `${own}/`.startsWith(`${dir}/`) ? undefined : dir
}

/**
 * End what outlived the tmux server, and resolve whether all of it exited.
 * SIGTERM first, so a build finishes writing its output. A process in the
 * cgroup that ignores it for `CONFIRM_TIMEOUT_MS` gets SIGKILL, or it would
 * hold the workspace's files and ports for good. `strays` are only ever
 * sent SIGTERM, and `rootPid`, the tmux server, not even that unless the
 * cgroup still lists it: a pid from a process table read earlier may be
 * someone else's by then, while the cgroup's members are read again before
 * each signal. The emptied slice is then removed from systemd.
 */
async function endLeftovers(strays: number[], rootPid: number | undefined, cgroup: string | undefined): Promise<boolean> {
  const termed = new Set<number>()
  const killAfter = Date.now() + CONFIRM_TIMEOUT_MS
  const exited = await waitFor(async () => {
    const members = cgroup === undefined ? [] : await cgroupPids(cgroup)
    const fresh = [...strays.filter((pid) => pid !== rootPid), ...members].filter((pid) => !termed.has(pid))
    killPids(fresh, 'SIGTERM')
    for (const pid of fresh) termed.add(pid)
    if (Date.now() >= killAfter) killPids(members, 'SIGKILL')
    return members.length === 0 && livePids(strays).length === 0
  }, { timeoutMs: CONFIRM_TIMEOUT_MS + (cgroup === undefined ? 0 : KILL_TIMEOUT_MS), intervalMs: POLL_MS })
  if (cgroup !== undefined) {
    await runHost(['systemctl', '--user', 'stop', path.basename(cgroup)], { timeoutMs: 5_000 }).catch(() => {})
  }
  return exited
}

/** See `WorkspaceDriver.destroy`. `true` only when tmux and every process
 *  the workspace started are confirmed gone, since the caller then deletes
 *  or moves what they write to; an agent still exiting writes its last
 *  lines on the way out. */
export async function destroyWorkspace(
  target: TeardownTarget,
  opts?: { unitOnly?: boolean },
): Promise<boolean> {
  const { projectId, workspaceId } = target
  const wasRunning = findWorkspace(workspaceId)?.running === true
  // Read before the marker is removed below.
  const agentPid = sshAgentPidOf(workspaceId)
  const paths = containerlessWorkspacePaths(target.unitName)
  // Captured before the kill, and only for a workspace seen running: after a
  // reboot the recorded pid may be an unrelated process of the user's.
  const rootPid = wasRunning ? tmuxPidOf(workspaceId) : undefined
  const strays = rootPid === undefined ? [] : descendantPids(await processTable(), [rootPid])
  // Read before the marker is removed below. It names the workspace, so
  // unlike the pid it is good for one this server never saw running.
  const cgroup = workspaceCgroup(workspaceId)

  try {
    await runHost(['tmux', '-S', paths.tmuxSock, 'kill-server'], { timeoutMs: 10_000 })
  } catch {
    // Already dead, or never started.
  }

  const gone = await confirmGone(paths.tmuxSock)
  // The ssh-agent is not tmux's descendant. Not gated on `wasRunning`: its
  // identity is verified by socket path instead, so it is killed even when
  // tmux already died.
  await killWorkspaceSshAgent(agentPid, paths.sshAgentSock)
  const exited = await endLeftovers(strays, rootPid, cgroup)

  // With `unitOnly` (a create retrying), keep the marker for the next
  // attempt.
  if (opts?.unitOnly !== true) {
    await removeMarker(projectId, workspaceId).catch((err: unknown) => {
      serverLog(`[server] containerless: marker cleanup for ${workspaceId}: ${String(err)}`)
    })
    // Socket files outlive the processes that bound them.
    await fs.rm(paths.tmuxSock, { force: true }).catch(() => { /* already gone */ })
    await fs.rm(paths.sshAgentSock, { force: true }).catch(() => { /* already gone */ })
    await fs.rm(paths.acpSockDir, { recursive: true, force: true })
      .catch(() => { /* already gone */ })
    dropWorkspace(workspaceId)
  }
  return gone && exited
}

/** Kill the workspace's ssh-agent if the pid is still that agent. */
async function killWorkspaceSshAgent(
  agentPid: number | undefined,
  sock: string,
): Promise<void> {
  if (agentPid === undefined) return
  if (!await isSshAgentFor(agentPid, sock)) return
  killPids([agentPid], 'SIGTERM')
}

function confirmGone(sock: string): Promise<boolean> {
  return waitFor(async () => !await tmuxAnswers(sock), { timeoutMs: CONFIRM_TIMEOUT_MS, intervalMs: POLL_MS })
}

/**
 * See `WorkspaceDriver.detachedTeardownCommand`. Every command is idempotent
 * and swallows its failure, so the caller's appended commands still run.
 */
export function detachedTeardownCommand(target: TeardownTarget): string {
  const paths = containerlessWorkspacePaths(target.unitName)
  const state = containerlessStateDir(target.projectId, target.workspaceId)
  // All paths are quoted: the data dir may contain spaces.
  //
  // The ssh-agent is found by its socket path in `ps` (no registry here).
  // The script's own command line would match too, so `[s]sh-agent` keeps
  // the pattern out of it and `$1 != me` excludes the shell's pid (and why
  // `pkill -f` is not used).
  //
  // After `kill-server`, wait (bounded, like `confirmGone`) for tmux to
  // exit before removing anything the panes may still write to.
  const sock = shellQuote(paths.tmuxSock)
  const cgroup = workspaceCgroup(target.workspaceId)
  return 'ps -eo pid=,args= 2>/dev/null '
    + `| grep '[s]sh-agent' | grep -F ${shellQuote(paths.sshAgentSock)} `
    + '| awk -v me=$$ \'$1 != me {print $1}\' | xargs -r kill 2>/dev/null || true; '
    + `tmux -S ${sock} kill-server 2>/dev/null || true; `
    + `i=0; while [ "$i" -lt ${String(CONFIRM_TIMEOUT_MS / POLL_MS)} ] `
    + `&& tmux -S ${sock} has-session -t yaac 2>/dev/null; do sleep ${String(POLL_MS / 1000)}; i=$((i+1)); done; `
    + (cgroup === undefined ? '' : cgroupSweepCommand(cgroup))
    + `rm -f ${shellQuote(paths.tmuxSock)} 2>/dev/null || true; `
    + `rm -f ${shellQuote(paths.sshAgentSock)} 2>/dev/null || true; `
    + `rm -rf ${shellQuote(paths.acpSockDir)} 2>/dev/null || true; `
    + `rm -rf ${shellQuote(state)} 2>/dev/null || true`
}

/**
 * `endLeftovers` for the detached script: SIGTERM once to each process in
 * the cgroup as it is first seen there, SIGKILL to what is left after
 * `CONFIRM_TIMEOUT_MS`, and the wait for it to empty before the caller's
 * removals.
 */
function cgroupSweepCommand(cgroup: string): string {
  const grace = CONFIRM_TIMEOUT_MS / POLL_MS
  return `i=0; seen=; while [ "$i" -lt ${String(grace + KILL_TIMEOUT_MS / POLL_MS)} ]; do `
    + `pids=$(find ${shellQuote(cgroup)} -name cgroup.procs -exec cat {} + 2>/dev/null); `
    + '[ -n "$pids" ] || break; '
    + `if [ "$i" -ge ${String(grace)} ]; then kill -9 $pids; `
    + 'else for p in $pids; do case " $seen " in *" $p "*) ;; *) kill "$p"; seen="$seen $p" ;; esac; done; fi 2>/dev/null; '
    + `sleep ${String(POLL_MS / 1000)}; i=$((i+1)); done; `
    + `systemctl --user stop ${shellQuote(path.basename(cgroup))} 2>/dev/null || true; `
}

/** See `WorkspaceDriver.destroyProjectSubstrate`. Only the project's
 *  node-local dirs on this host. */
export async function destroyProjectSubstrate(projectId: string): Promise<void> {
  const dir = nodeLocalProjectPath(projectId)
  await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
    serverLog(`[server] containerless: remove ${dir}: ${String(err)}`)
  })
}

/** A node-local tree written this recently is skipped (a create may be
 *  staging into it). */
const REAP_SLACK_MS = 10_000

/**
 * See `WorkspaceDriver.reapNodeLocal`. Removes project trees on this host
 * not named by a live project id; cheap enough to run every pass. A symlinked
 * root or entry is left alone. There are no per-workspace leftovers
 * (opencode uses its checkpoint directly).
 */
export async function reapNodeLocal(live: NodeLocalLiveSet): Promise<void> {
  const cutoff = Date.now() - REAP_SLACK_MS
  const root = nodeLocalPath('projects')
  if (!(await fs.lstat(root).catch(() => null))?.isDirectory()) return
  for (const name of await fs.readdir(root).catch((): string[] => [])) {
    if (live.projectIds.has(name)) continue
    const dir = path.join(root, name)
    const stat = await fs.lstat(dir).catch(() => null)
    if (!stat?.isDirectory() || stat.mtimeMs > cutoff) continue
    await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      serverLog(`[server] containerless: reap ${dir}: ${String(err)}`)
    })
  }
}
