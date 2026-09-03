import fs from 'node:fs/promises'
import { serverLog } from '#log'
import { shellQuote } from '#lib/shell'
import { descendantPids, isSshAgentFor, killPids, runHost } from './host'
import {
  containerlessWorkspacePaths,
  workspaceStateDir,
} from './paths'
import {
  findWorkspace,
  forgetWorkspace,
  markTerminating,
  removeMarker,
  sshAgentPidOf,
  tmuxPidOf,
} from './registry'
import type { TeardownTarget } from '#drivers/contract'

/**
 * Taking a workspace down: the tmux server, whatever survived it, and the
 * marker that said it existed.
 *
 * `kill-server` is the whole of the intended path — tmux SIGHUPs every pane
 * and the agent exits with its window. The descendant sweep after it is for
 * what a pane leaked: an init command's dev server that double-forked out of
 * the process group is not tmux's to kill, and on a shared host it would
 * otherwise hold its port forever.
 */

/** How long to wait for the tmux server to actually be gone before
 *  reporting that we could not confirm it. */
const CONFIRM_TIMEOUT_MS = 10_000

/** See `WorktreeDriver.destroy`. Resolves `true` only when the workspace is
 *  really gone — the caller deletes the checkout on that verdict, so a
 *  `false` has to mean "something may still be writing there". */
export async function destroyWorkspace(
  target: TeardownTarget,
  opts?: { unitOnly?: boolean },
): Promise<boolean> {
  const { projectSlug, workspaceId } = target
  // Whether this workspace was observed RUNNING, read before the terminating
  // mark. It gates the stray sweep below, and nothing else here.
  const wasRunning = findWorkspace(workspaceId)?.running === true
  // Read before the marker is removed below: this is the process holding
  // the worktree's ssh key in memory, and losing the pid would leave it
  // running with nothing left on disk to say it exists.
  const agentPid = sshAgentPidOf(workspaceId)
  markTerminating(workspaceId)
  const paths = containerlessWorkspacePaths(target.unitName)
  // Captured BEFORE the kill: afterwards the tmux server is gone and there
  // is nothing left to enumerate a tree from.
  //
  // Only for a workspace we just saw running. The marker's pid is advisory
  // — pids are recycled — and this verb runs for DEAD workspaces too: a
  // worktree recovered dead after a host reboot, then stopped by the user.
  // There, the pre-reboot pid names some unrelated process of this user, and
  // sweeping its tree would SIGTERM their editor.
  const rootPid = wasRunning ? tmuxPidOf(workspaceId) : undefined
  const strays = rootPid === undefined ? [] : await descendantPids([rootPid])

  try {
    await runHost(['tmux', '-S', paths.tmuxSock, 'kill-server'], { timeoutMs: 10_000 })
  } catch {
    // Already dead, or never started — both mean there is no server to kill,
    // which is the state this was asking for.
  }

  const gone = await confirmGone(paths.tmuxSock)
  // The ssh-agent, before the strays: it is not a descendant of the tmux
  // server (it was started beside it, detached), so nothing else here would
  // reach it. UNLIKE the stray sweep, this is not gated on having seen the
  // workspace running — a worktree whose tmux died while the host stayed up
  // would otherwise leave an agent holding the private key until reboot,
  // which is the failure the per-worktree agent exists to prevent. What
  // replaces the gate is checking the pid is still this agent, which the
  // socket path in its argv answers exactly.
  await killWorkspaceSshAgent(agentPid, paths.sshAgentSock)
  if (strays.length > 0) {
    // TERM first, and no KILL follow-up: everything here is a descendant of
    // a shell the user's own config started, and a hard kill of a build or
    // a dev server risks leaving its own artifacts half-written. What
    // survives is reported rather than fought with.
    killPids(strays.filter((pid) => pid !== rootPid), 'SIGTERM')
  }

  // `unitOnly` protects what was prepared AROUND the workspace across a
  // relaunch. Nothing is prepared around one here, but the marker is what a
  // recovery scan reads — removing it on a retry-in-progress create would
  // hide a workspace the next attempt is about to reuse.
  if (opts?.unitOnly !== true) {
    await removeMarker(projectSlug, workspaceId).catch((err: unknown) => {
      serverLog(`[server] containerless: marker cleanup for ${workspaceId}: ${String(err)}`)
    })
    // The sockets and the acp dir outlive the servers that bound them.
    await fs.rm(paths.tmuxSock, { force: true }).catch(() => { /* already gone */ })
    await fs.rm(paths.sshAgentSock, { force: true }).catch(() => { /* already gone */ })
    await fs.rm(paths.acpSockDir, { recursive: true, force: true })
      .catch(() => { /* already gone */ })
    forgetWorkspace(workspaceId)
  }
  return gone
}

/**
 * End the agent holding this workspace's ssh key, if it is still that agent.
 *
 * Best-effort in both directions: a pid that now names something else is
 * left alone, and a `ps` that will not answer loses only the kill.
 */
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
      // The probe failed, which is what "no session" looks like.
      return true
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * See `WorktreeDriver.detachedTeardownCommand`.
 *
 * Every command tolerates having already run, because the whole script is
 * re-issued when a teardown has to be resumed: `kill-server` against a dead
 * socket and `rm -rf` of an absent directory are both no-ops, and their
 * failures are swallowed so a later command in the caller's composed script
 * still runs.
 */
export function detachedTeardownCommand(target: TeardownTarget): string {
  const paths = containerlessWorkspacePaths(target.unitName)
  const state = workspaceStateDir(target.projectSlug, target.workspaceId)
  // Quoted, and this is the site where it matters most: both paths are
  // derived from the data dir and `os.tmpdir()`, so a space or a glob
  // character in either (`YAAC_DATA_DIR=…/My Drive/yaac`) would split the
  // `rm -rf` into removals of two paths nobody named. The caller composes
  // its own quoted `rm`s into the same script (`cleanup.ts`), so this half
  // has to hold up the same way.
  // The socket files and the acp dir outlive the servers that bound them;
  // nothing else would ever collect them, so a long-lived host would
  // accumulate a set per worktree it ever ran until a reboot.
  //
  // The ssh-agent is killed by matching its own socket path in `ps` output
  // rather than by a recorded pid: this script runs detached, with no
  // registry to read, and the process holds a private key in memory — so
  // leaving it for the reboot is the one thing this must not do.
  //
  // Two guards against the script matching ITSELF, which would kill the
  // shell mid-teardown and skip every command after this one. `sh -c` puts
  // the whole script in the shell's own argv, so `ps` lists it: the
  // `[s]sh-agent` idiom is what keeps it out — the pattern matches the
  // string "ssh-agent" while the script's own text does not contain it — and
  // `$1 != me` excludes the shell by pid regardless, so a later edit that
  // reintroduces the literal cannot bring the bug back. `pkill -f` is not
  // used for the same reason: it would match this command line too.
  return 'ps -eo pid=,args= 2>/dev/null '
    + `| grep '[s]sh-agent' | grep -F ${shellQuote(paths.sshAgentSock)} `
    + '| awk -v me=$$ \'$1 != me {print $1}\' | xargs -r kill 2>/dev/null || true; '
    + `tmux -S ${shellQuote(paths.tmuxSock)} kill-server 2>/dev/null || true; `
    + `rm -f ${shellQuote(paths.tmuxSock)} 2>/dev/null || true; `
    + `rm -f ${shellQuote(paths.sshAgentSock)} 2>/dev/null || true; `
    + `rm -rf ${shellQuote(paths.acpSockDir)} 2>/dev/null || true; `
    + `rm -rf ${shellQuote(state)} 2>/dev/null || true`
}

/**
 * See `WorktreeDriver.destroyProjectSubstrate`. There is nothing a project
 * holds here beyond its worktrees — no registry, no cluster objects, no
 * proxy registration — and the caller has already torn those down.
 */
export function destroyProjectSubstrate(): Promise<void> {
  return Promise.resolve()
}
