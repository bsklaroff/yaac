import { k8sNamespace, shellKubectlWithRetry, type KubectlExecOptions } from './kubectl'

/** kubectl target for a workspace Job; kubectl resolves its pod. */
export function execTarget(jobName: string): string {
  return `job/${jobName}`
}

/**
 * Run a command in a workspace container via `kubectl exec`, retrying
 * transient API errors. `cmd` is already shell-quoted by the caller.
 *
 * Only for commands that cannot wait for streamd: booting streamd itself
 * (`bootStreamd`) and the teardown-time image salvage survey. Everything
 * else uses `podExec` over the stream relay.
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
