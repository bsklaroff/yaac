import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { runClusterCheck } from '@/lib/k8s/cluster-check'
import { runClusterSetup, ClusterSetupError, streamingClusterSetupDeps } from '@/lib/k8s/cluster-setup'

/**
 * Cluster readiness + first-run setup for the desktop shell.
 *
 *   GET  /cluster/check → { ok, results }         (same as `yaac cluster check`)
 *   POST /cluster/setup → NDJSON progress stream  (runs `yaac cluster setup`)
 *
 * The webapp gates on `/check`: green → straight in; not green → the setup
 * screen drives `/setup` and shows the streamed progress.
 */
export const clusterApp = new Hono()
  .get('/check', async (c) => {
    const { ok, results } = await runClusterCheck()
    return c.json({ ok, results })
  })
  .post('/setup', (c) => stream(c, async (s) => {
    // NDJSON: {type:'progress'|'result'|'error'}. Errors thrown inside the
    // stream callback are swallowed by hono, so catch and emit them.
    const write = async (obj: unknown): Promise<void> => { await s.write(`${JSON.stringify(obj)}\n`) }
    try {
      const ok = await runClusterSetup(
        {},
        streamingClusterSetupDeps((message) => { void write({ type: 'progress', message }) }),
      )
      await write({ type: 'result', ok })
    } catch (err) {
      const message = err instanceof ClusterSetupError || err instanceof Error
        ? err.message
        : String(err)
      await write({ type: 'error', error: { message } })
    }
  }))
