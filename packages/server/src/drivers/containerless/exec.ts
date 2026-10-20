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
  opts?: { timeout?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return await runHost(['sh', '-c', cmd], {
    cwd: containerlessWorkspacePaths(jobName).workspaceDir,
    env: workspaceRunEnvironment(jobName),
    timeoutMs: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  })
}

/** Whether a workspace's tmux server, on socket `sock`, answers. */
export function tmuxAnswers(sock: string): Promise<boolean> {
  return runHost(['tmux', '-S', sock, 'has-session', '-t', 'yaac'], { timeoutMs: 5_000 })
    .then(() => true, () => false)
}
