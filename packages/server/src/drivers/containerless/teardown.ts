import fs from 'node:fs/promises'
import path from 'node:path'
import { imageStoreDir, nodeLocalPath, nodeLocalProjectPath } from '@yaac/shared/project-paths'
import { serverLog } from '#log'
import { shellQuote } from '#lib/shell'
import { descendantPids, isSshAgentFor, killPids, runHost } from './host'
import {
  containerlessWorkspacePaths,
  containerlessStateDir,
} from './paths'
import {
  findWorkspace,
  forgetWorkspace,
  listWorkspaces,
  markTerminating,
  removeMarker,
  sshAgentPidOf,
  tmuxPidOf,
} from './registry'
import type { NodeLocalLiveSet, ProjectRef, TeardownTarget } from '#drivers/contract'

/**
 * Taking a workspace down: `kill-server` (tmux SIGHUPs every pane), then a
 * sweep of leftover descendants (e.g. a dev server that double-forked away
 * from tmux and would hold its port forever), the ssh-agent, and the marker.
 */

/** How long to wait for the tmux server to exit. */
const CONFIRM_TIMEOUT_MS = 10_000

/** See `WorkspaceDriver.destroy`. `true` only when tmux is confirmed gone,
 *  since the caller then deletes the checkout. */
export async function destroyWorkspace(
  target: TeardownTarget,
  opts?: { unitOnly?: boolean },
): Promise<boolean> {
  const { projectSlug, workspaceId } = target
  const wasRunning = findWorkspace(workspaceId)?.running === true
  // Read before the marker is removed below.
  const agentPid = sshAgentPidOf(workspaceId)
  markTerminating(workspaceId)
  const paths = containerlessWorkspacePaths(target.unitName)
  // Captured before the kill, and only for a workspace seen running: after a
  // reboot the recorded pid may be an unrelated process of the user's.
  const rootPid = wasRunning ? tmuxPidOf(workspaceId) : undefined
  const strays = rootPid === undefined ? [] : await descendantPids([rootPid])

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
  if (strays.length > 0) {
    // TERM only: a hard kill could leave build output half-written.
    killPids(strays.filter((pid) => pid !== rootPid), 'SIGTERM')
  }

  // With `unitOnly` (a create retrying), keep the marker for the next
  // attempt.
  if (opts?.unitOnly !== true) {
    await removeMarker(projectSlug, workspaceId).catch((err: unknown) => {
      serverLog(`[server] containerless: marker cleanup for ${workspaceId}: ${String(err)}`)
    })
    // Socket files outlive the processes that bound them.
    await fs.rm(paths.tmuxSock, { force: true }).catch(() => { /* already gone */ })
    await fs.rm(paths.sshAgentSock, { force: true }).catch(() => { /* already gone */ })
    await fs.rm(paths.acpSockDir, { recursive: true, force: true })
      .catch(() => { /* already gone */ })
    forgetWorkspace(workspaceId)
  }
  return gone
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

async function confirmGone(sock: string): Promise<boolean> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS
  for (;;) {
    try {
      await runHost(['tmux', '-S', sock, 'has-session', '-t', 'yaac'], { timeoutMs: 5_000 })
    } catch {
      // No session.
      return true
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * See `WorkspaceDriver.detachedTeardownCommand`. Every command is idempotent
 * and swallows its failure, so the caller's appended commands still run.
 */
export function detachedTeardownCommand(target: TeardownTarget): string {
  const paths = containerlessWorkspacePaths(target.unitName)
  const state = containerlessStateDir(target.projectSlug, target.workspaceId)
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
  return 'ps -eo pid=,args= 2>/dev/null '
    + `| grep '[s]sh-agent' | grep -F ${shellQuote(paths.sshAgentSock)} `
    + '| awk -v me=$$ \'$1 != me {print $1}\' | xargs -r kill 2>/dev/null || true; '
    + `tmux -S ${sock} kill-server 2>/dev/null || true; `
    + `i=0; while [ "$i" -lt ${String(CONFIRM_TIMEOUT_MS / 200)} ] `
    + `&& tmux -S ${sock} has-session -t yaac 2>/dev/null; do sleep 0.2; i=$((i+1)); done; `
    + `rm -f ${shellQuote(paths.tmuxSock)} 2>/dev/null || true; `
    + `rm -f ${shellQuote(paths.sshAgentSock)} 2>/dev/null || true; `
    + `rm -rf ${shellQuote(paths.acpSockDir)} 2>/dev/null || true; `
    + `rm -rf ${shellQuote(state)} 2>/dev/null || true`
}

/** See `WorkspaceDriver.destroyProjectSubstrate`. Only the project's
 *  node-local dirs on this host. */
export async function destroyProjectSubstrate(project: ProjectRef): Promise<void> {
  for (const dir of [nodeLocalProjectPath(project.id), imageStoreDir(project.id)]) {
    await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      serverLog(`[server] containerless: remove ${dir}: ${String(err)}`)
    })
  }
}

/** A node-local tree written this recently is skipped (a create may be
 *  staging into it). */
const REAP_SLACK_MS = 10_000

/**
 * See `WorkspaceDriver.reapNodeLocal`. Removes project trees on this host
 * not named by a live project id; cheap enough to run every pass. Symlinked
 * roots and entries are left alone. There are no per-workspace leftovers
 * (opencode uses its checkpoint directly).
 */
export async function reapNodeLocal(live: NodeLocalLiveSet): Promise<void> {
  // Legacy-compat (docs/legacy-compat-shims.md, "Workspaces started before
  // project ids"): a running workspace's slug keeps its slug-named tree.
  const kept = new Set([...live.projectIds, ...listWorkspaces().map((w) => w.projectSlug)])
  const cutoff = Date.now() - REAP_SLACK_MS
  for (const root of [nodeLocalPath('projects'), nodeLocalPath('shared-images')]) {
    if (!(await fs.lstat(root).catch(() => null))?.isDirectory()) continue
    for (const name of await fs.readdir(root).catch((): string[] => [])) {
      if (kept.has(name)) continue
      const dir = path.join(root, name)
      const stat = await fs.lstat(dir).catch(() => null)
      if (!stat?.isDirectory() || stat.mtimeMs > cutoff) continue
      await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        serverLog(`[server] containerless: reap ${dir}: ${String(err)}`)
      })
    }
  }
}
