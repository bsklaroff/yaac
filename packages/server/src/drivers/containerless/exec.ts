import type { ChangesReading, ChangesRequest } from '#drivers/contract'
import { waitFor } from '#lib/wait-for'
import { buildChangesScript, parseChangesOutput, runChangesRead } from '#drivers/shared'
import { runHost } from './host'
import { workspaceRunEnvironment } from './launch'
import { containerlessWorkspacePaths } from './paths'

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

/** See `WorkspaceDriver.changes`. Runs host git in the checkout. */
export function getWorkspaceChanges(jobName: string, request: ChangesRequest): Promise<ChangesReading> {
  const paths = containerlessWorkspacePaths(jobName)
  return runChangesRead(jobName, request, async (req) => {
    const { stdout } = await runHost([
      'sh', '-c',
      buildChangesScript({
        workspaceDir: paths.workspaceDir,
        indexFile: `${paths.scratchDir}/yaac-changes.idx`,
      }, req),
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
