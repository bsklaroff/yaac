import { k8sNamespace, shellKubectlWithRetry, type KubectlExecOptions } from './kubectl'

/**
 * kubectl target for a worktree Job. `kubectl exec job/<name>` resolves the
 * Job's pod server-side, so callers never need the concrete pod name for
 * exec paths.
 */
export function execTarget(jobName: string): string {
  return `job/${jobName}`
}

/**
 * Run a command inside a worktree container as the `yaac` user, retrying
 * transient API errors. `cmd` is a full shell-formatted command tail
 * (quoting handled by the caller) — the k8s replacement for
 * `podman exec <container> <cmd>`.
 *
 * Scope: the streamd boot/self-heal itself (`bootStreamd` — the one exec
 * that must work when no stream can reach the pod) and pod commands that
 * cannot gate on streamd, such as the teardown-time image salvage survey.
 * Everything else on a worktree pod rides the stream relay instead
 * (`podExec` in platform/k8s/stream-relay), including worktree-create
 * setup and claim-time retool/rebranch prep, which gate on
 * `waitForStreamd` first.
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
