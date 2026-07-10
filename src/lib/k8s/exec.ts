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
 * used by the server's PTY bridge, which spawns kubectl under node-pty.
 * (The CLI's attach/shell commands ride the server's /pty/attach
 * WebSocket instead of exec'ing kubectl client-side.)
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
