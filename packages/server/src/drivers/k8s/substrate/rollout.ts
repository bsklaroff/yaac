import { kubectlWithRetry } from './kubectl'

/**
 * Wait for a workload (`deployment/<name>`, `daemonset/<name>`) to finish
 * rolling out. kubectl only reports that it timed out, so a failure is
 * rethrown with `hint`: where to look and the likely causes.
 */
export async function waitForRollout(opts: {
  workload: string
  namespace: string
  timeoutMs: number
  hint?: string
}): Promise<void> {
  try {
    await kubectlWithRetry([
      'rollout', 'status', opts.workload, '-n', opts.namespace,
      `--timeout=${String(Math.floor(opts.timeoutMs / 1000))}s`,
    ], { timeout: opts.timeoutMs + 10_000, maxAttempts: 2 })
  } catch (err) {
    if (!opts.hint) throw err
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${opts.hint}`)
  }
}
