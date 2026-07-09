import { spawn } from 'node:child_process'
import { k8sNamespace, shellKubectlWithRetry, type KubectlExecOptions } from '@/lib/k8s/kubectl'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'

/**
 * kubectl target for a session Job. `kubectl exec job/<name>` resolves the
 * Job's pod server-side, so callers never need the concrete pod name for
 * exec paths.
 */
export function execTarget(jobName: string): string {
  return `job/${jobName}`
}

/**
 * Run a command inside a session container as the `yaac` user, retrying
 * transient API errors. `cmd` is a full shell-formatted command tail
 * (quoting handled by the caller) — the k8s replacement for
 * `podman exec <container> <cmd>`.
 */
export async function containerExec(
  jobName: string,
  cmd: string,
  opts: KubectlExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return shellKubectlWithRetry(
    `kubectl exec -n ${k8sNamespace()} ${execTarget(jobName)} -- ${cmd}`,
    opts,
  )
}

/**
 * argv for an interactive `kubectl exec -it` into a session container —
 * used by the CLI attach/shell commands and the daemon's PTY bridge,
 * which spawn kubectl with a real TTY (stdio inherit / node-pty).
 */
export function interactiveExecArgs(jobName: string, command: string[]): string[] {
  return ['exec', '-n', k8sNamespace(), '-it', execTarget(jobName), '--', ...command]
}

/**
 * Run an interactive `kubectl exec -it` with the user's terminal attached
 * (stdio inherit) — the CLI attach/shell/create/restart/stream path.
 * Resolves when kubectl exits regardless of exit code (a killed Job or
 * tmux session closes the TTY the same way a clean detach does); rejects
 * only when kubectl itself fails to spawn.
 */
export function runInteractiveExec(jobName: string, command: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('kubectl', interactiveExecArgs(jobName, command), { stdio: 'inherit' })
    child.on('close', () => resolve())
    child.on('error', reject)
  })
}

/**
 * Attach the user's terminal to a tmux session inside a session container.
 */
export function attachTmux(jobName: string, tmuxSession: string): Promise<void> {
  return runInteractiveExec(jobName, ['tmux', '-S', CONTAINER_TMUX_SOCK, 'attach-session', '-t', tmuxSession])
}

/**
 * argv for a non-TTY stdin-piped exec (`kubectl exec -i`) — used by the
 * per-connection port-forward relays that pipe a TCP socket through `nc`
 * inside the container.
 */
export function stdinExecArgs(jobName: string, command: string[]): string[] {
  return ['exec', '-n', k8sNamespace(), '-i', execTarget(jobName), '--', ...command]
}
