import { CHANGES_BASE_UNRESOLVED } from '#drivers/contract'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { waitFor } from '#lib/wait-for'
import { buildChangesScript, parseChangesOutput } from '#drivers/shared'
import { runHost } from './host'
import { workspaceRunEnvironment } from './launch'
import { containerlessWorkspacePaths } from './paths'
import type { WorkspaceChanges } from '@yaac/shared/types'

/**
 * Running commands "inside" a workspace: on the host, in its checkout, with
 * its environment. The environment carries the per-workspace `HOME` and
 * agent credentials; without it a command would read the server user's
 * config (see `workspaceRunEnvironment`).
 */

const DEFAULT_TIMEOUT_MS = 30_000

/** See `WorkspaceDriver.exec`. There is no transport to retry, so
 *  `maxAttempts` does not apply. */
export async function execInWorkspace(
  jobName: string,
  cmd: string,
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return await runHost(['sh', '-c', cmd], {
    cwd: containerlessWorkspacePaths(jobName).workspaceDir,
    env: workspaceRunEnvironment(jobName),
    timeoutMs: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
  })
}

/** One run per workspace at a time: runs share one git index file. */
const changesMutex = createKeyedMutex()

/** See `WorkspaceDriver.changes`. Runs host git in the checkout. */
export function getWorkspaceChanges(
  jobName: string,
  base?: string,
  defaultBase?: string,
): Promise<WorkspaceChanges> {
  const paths = containerlessWorkspacePaths(jobName)
  return changesMutex(jobName, async () => {
    const { stdout } = await runHost([
      'sh', '-c',
      buildChangesScript({
        workspaceDir: paths.workspaceDir,
        indexFile: `${paths.scratchDir}/yaac-changes.idx`,
        baseUnresolvedCode: CHANGES_BASE_UNRESOLVED,
      }, base, defaultBase),
    ], { cwd: paths.workspaceDir, env: workspaceRunEnvironment(jobName), timeoutMs: 20_000 })
    return parseChangesOutput(stdout)
  })
}

/** Whether a workspace's tmux server, on socket `sock`, answers. */
export function tmuxAnswers(sock: string): Promise<boolean> {
  return runHost(['tmux', '-S', sock, 'has-session', '-t', 'yaac'], { timeoutMs: 5_000 })
    .then(() => true, () => false)
}

/** See `WorkspaceDriver.awaitAgentTransport`. Polls until the workspace's
 *  tmux server answers, since there is no separate transport. */
export async function awaitAgentTransport(
  jobName: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const { tmuxSock } = containerlessWorkspacePaths(jobName)
  const timeoutMs = opts?.timeoutMs ?? 30_000
  if (!await waitFor(() => tmuxAnswers(tmuxSock), { timeoutMs, intervalMs: 200 })) {
    throw new Error(`containerless ${jobName}: tmux session did not answer within the deadline (${String(timeoutMs)}ms)`)
  }
}
