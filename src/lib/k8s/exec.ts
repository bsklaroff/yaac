import { k8sNamespace, shellKubectlWithRetry, type KubectlExecOptions } from '@/lib/k8s/kubectl'

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
 * argv for a non-TTY stdin-piped exec (`kubectl exec -i`) — used by the
 * per-connection port-forward relays that pipe a TCP socket through `nc`
 * inside the container.
 */
export function stdinExecArgs(jobName: string, command: string[]): string[] {
  return ['exec', '-n', k8sNamespace(), '-i', execTarget(jobName), '--', ...command]
}

/**
 * argv for a streaming, non-interactive exec (`kubectl exec` with no
 * `-i`/`-it`) — used by the port detector's long-lived poll loop, which only
 * reads the command's stdout and never writes to it. Without a TTY the
 * in-pod `sleep` loop runs unbuffered and kubectl streams each poll's output
 * as it is produced.
 */
export function streamExecArgs(jobName: string, command: string[]): string[] {
  return ['exec', '-n', k8sNamespace(), execTarget(jobName), '--', ...command]
}
