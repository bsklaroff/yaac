import { k8sNamespace, shellKubectlWithRetry, type KubectlExecOptions } from './kubectl'

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
 *
 * Scope: session-create provisioning (the bounded setup execs that run
 * before streamd exists, incl. claim-time retool/rebranch prep) and the
 * streamd boot/self-heal itself. Steady-state session-pod commands ride
 * the stream relay instead (`sessionExec` in platform/k8s/stream-relay).
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
