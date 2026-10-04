import type { Context } from 'hono'
import { stream } from 'hono/streaming'
import { runProvisioned } from '#domain/workspaces'
import { toErrorBody } from '#http'

/**
 * Writes the NDJSON provisioning stream for the workspace create/restart
 * routes: `{type:'progress'}` events, then exactly one `{type:'result'}` or
 * `{type:'error'}`. Hono swallows errors thrown inside a stream callback, so
 * `run` failures are caught and emitted.
 *
 * `runProvisioned` updates the provisioning-registry row the webapp sees;
 * this mirrors the same progress onto the stream for the CLI. The caller
 * registers the row (restart does so only when the webapp supplied its
 * project); registry calls are no-ops while no row exists.
 */
export function streamProvisioned(
  c: Context,
  workspaceId: string,
  run: (onProgress: (message: string) => void) => Promise<{ workspaceId: string }>,
): Response {
  c.header('Content-Type', 'application/x-ndjson')
  return stream(c, async (s) => {
    const write = (event: unknown) => s.writeln(JSON.stringify(event))
    try {
      const result = await runProvisioned(workspaceId, (onProgress) =>
        run((message) => {
          onProgress(message)
          void write({ type: 'progress', message })
        }))
      await write({ type: 'result', result })
    } catch (err) {
      await write({ type: 'error', error: toErrorBody(err).body.error })
    }
  })
}
