import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { k8sNamespace } from './api'

const execAsync = promisify(exec)

/**
 * Run a command in a workspace container via `kubectl exec`; kubectl
 * resolves the Job's pod. `cmd` is already shell-quoted by the caller.
 *
 * Only for commands that cannot wait for streamd: booting streamd itself
 * (`bootStreamd`) and the teardown-time image salvage survey. Everything
 * else uses `podExec` over the stream relay.
 */
export async function containerExec(
  jobName: string,
  cmd: string,
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const res = await execAsync(
    `kubectl exec -n ${k8sNamespace()} job/${jobName} -- ${cmd}`,
    { maxBuffer: 64 << 20, timeout: opts.timeout },
  )
  return { stdout: res.stdout.toString(), stderr: res.stderr.toString() }
}
