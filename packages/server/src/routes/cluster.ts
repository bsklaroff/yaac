import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { runClusterCheck } from '#lib/k8s/cluster-check'
import { runClusterSetup, ClusterSetupError, streamingClusterSetupDeps } from '#lib/k8s/cluster-setup'
import type { CheckResult, ClusterSetupEvent } from '@yaac/shared/types'

/**
 * Cluster readiness + first-run setup, mounted at /cluster.
 *
 *   GET  /cluster/check → { ok, results }         (same as `yaac cluster check`)
 *   POST /cluster/setup → NDJSON progress stream  (runs `yaac cluster setup`)
 *
 * The webapp gates on `/check`: green → straight in; not green → the setup
 * screen drives `/setup` and shows the streamed progress. A factory (like
 * createTokensApp) so tests can inject fakes — the real check/setup shell
 * out to kubectl/kind and probe the cluster with actual pods.
 */
export interface ClusterRouteDeps {
  check(): Promise<{ ok: boolean; results: CheckResult[] }>
  /** Run the full setup, reporting progress lines; resolves to the final
   *  cluster-check verdict. Throws ClusterSetupError on an unrecoverable step. */
  setup(onProgress: (message: string) => void): Promise<boolean>
}

export const defaultClusterRouteDeps: ClusterRouteDeps = {
  check: () => runClusterCheck(),
  setup: (onProgress) => runClusterSetup({}, streamingClusterSetupDeps(onProgress)),
}

export function createClusterApp(deps: ClusterRouteDeps = defaultClusterRouteDeps) {
  return new Hono()
    .get('/check', async (c) => {
      const { ok, results } = await deps.check()
      return c.json({ ok, results })
    })
    .post('/setup', (c) => stream(c, async (s) => {
      // NDJSON ClusterSetupEvent per line. Errors thrown inside the stream
      // callback are swallowed by hono, so catch and emit them.
      const write = async (obj: ClusterSetupEvent): Promise<void> => {
        await s.write(`${JSON.stringify(obj)}\n`)
      }
      try {
        const ok = await deps.setup((message) => { void write({ type: 'progress', message }) })
        await write({ type: 'result', ok })
      } catch (err) {
        const message = err instanceof ClusterSetupError || err instanceof Error
          ? err.message
          : String(err)
        await write({ type: 'error', error: { message } })
      }
    }))
}
