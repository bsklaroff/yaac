import { CHANGES_BASE_UNRESOLVED } from '#drivers/contract'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { buildChangesScript, parseChangesOutput } from '#drivers/shared'
import { runHost } from './host'
import { containerlessWorkspacePaths, refFromJobName } from './paths'
import { workspaceEnv } from './registry'
import type { WorktreeChanges } from '@yaac/shared/types'

/**
 * Running a command inside a workspace, which on this substrate means
 * running it on the host in the workspace's checkout with the workspace's
 * environment.
 *
 * The environment matters more than it looks: it carries `HOME` (the
 * per-worktree home the tool configs are symlinked into) and the agent
 * credentials, so a command run without it would read the SERVER user's
 * configuration instead of the worktree's. After a restart the table has no
 * env — the tmux server holds the real copy — and commands fall back to the
 * server's own, which is correct for the tmux invocations that make up
 * essentially all of this verb's traffic.
 */

const DEFAULT_TIMEOUT_MS = 30_000

/** See `WorktreeDriver.exec`. */
export async function execInWorkspace(
  jobName: string,
  cmd: string,
  opts?: { timeout?: number; maxAttempts?: number },
): Promise<{ stdout: string; stderr: string }> {
  const { worktreeId } = refFromJobName(jobName)
  const paths = containerlessWorkspacePaths(jobName)
  const attempts = Math.max(1, opts?.maxAttempts ?? 1)
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await runHost(['sh', '-c', cmd], {
        // The checkout may not exist yet on the very first setup command;
        // falling back keeps that a command failure rather than a spawn one.
        cwd: paths.workspaceDir,
        ...(workspaceEnv(worktreeId) !== undefined
          ? { env: workspaceEnv(worktreeId) as NodeJS.ProcessEnv }
          : {}),
        timeoutMs: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
      })
    } catch (err) {
      lastErr = err
      // A retry is only ever for the transport, and there is no transport
      // here worth retrying: a nonzero exit is a verdict about the
      // workspace, and re-running the command would just repeat it.
      break
    }
  }
  throw lastErr
}

/**
 * One run at a time per worktree: the runs share a single index file, and
 * two overlapping `git add -A` calls would collide on its lock.
 */
const changesMutex = createKeyedMutex()

/** See `WorktreeDriver.changes`. Host git in the worktree's own checkout —
 *  there is no path translation to do, because the checkout the agent sees
 *  is the one the server made. */
export function getWorktreeChanges(
  jobName: string,
  base?: string,
  defaultBase?: string,
): Promise<WorktreeChanges> {
  const paths = containerlessWorkspacePaths(jobName)
  return changesMutex(jobName, async () => {
    const { stdout } = await runHost([
      'sh', '-c',
      buildChangesScript({
        workspaceDir: paths.workspaceDir,
        indexFile: `${paths.scratchDir}/yaac-changes.idx`,
        baseUnresolvedCode: CHANGES_BASE_UNRESOLVED,
      }, base, defaultBase),
    ], { cwd: paths.workspaceDir, timeoutMs: 20_000 })
    return parseChangesOutput(stdout)
  })
}

/**
 * See `WorktreeDriver.awaitAgentTransport`. Poll until the workspace's tmux
 * server answers.
 *
 * There is no daemon between the server and the workspace here — the
 * transport IS the tmux socket — so this waits for the thing every later
 * command will address rather than for a separate relay to come up.
 */
export async function awaitAgentTransport(
  jobName: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const paths = containerlessWorkspacePaths(jobName)
  const deadline = Date.now() + (opts?.timeoutMs ?? 30_000)
  let lastErr: unknown
  for (;;) {
    try {
      await runHost(['tmux', '-S', paths.tmuxSock, 'has-session', '-t', 'yaac'], {
        timeoutMs: 5_000,
      })
      return
    } catch (err) {
      lastErr = err
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error(
    `containerless ${jobName}: tmux session did not answer within the deadline `
    + `(${String(lastErr)})`,
  )
}
