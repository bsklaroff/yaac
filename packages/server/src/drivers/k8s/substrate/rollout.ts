import { execFileAsync } from './api'

/**
 * Wait for a workload (`deployment/<name>`, `daemonset/<name>`) to finish
 * rolling out. This stays `kubectl rollout status`: it already encodes each
 * workload kind's notion of done (observed generation, updated and
 * available replicas, progress deadline), which a typed watch would have
 * to restate. kubectl only reports that it timed out, so a failure is
 * rethrown with `hint`: where to look and the likely causes.
 */
export async function waitForRollout(opts: {
  workload: string
  namespace: string
  timeoutMs: number
  hint?: string
}): Promise<void> {
  try {
    await execFileAsync('kubectl', [
      'rollout', 'status', opts.workload, '-n', opts.namespace,
      `--timeout=${String(Math.floor(opts.timeoutMs / 1000))}s`,
    ], { timeout: opts.timeoutMs + 10_000 })
  } catch (err) {
    if (!opts.hint) throw err
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${opts.hint}`)
  }
}
