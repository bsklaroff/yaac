import type { Context } from 'hono'
import { stream } from 'hono/streaming'
import { runProvisioned } from '#domain/workspaces'
import { toErrorBody } from '#http'

/**
 * Writer side of the NDJSON provisioning streams shared by the workspace
 * create/restart routes: `{type:'progress'}` events followed by exactly one
 * terminal `{type:'result'}` or `{type:'error'}` (errors thrown inside a hono
 * stream callback are swallowed, so `run` failures are caught and emitted).
 *
 * The provisioning-registry row lifecycle (webapp, snapshot-driven) is
 * `runProvisioned`'s job — this layer only mirrors the same progress and
 * outcome onto the NDJSON stream (CLI), keeping both in sync. Registering the
 * `workspaceId` row is the caller's job (restart registers up front only when
 * the webapp supplied the row's project) — all registry calls are no-ops while
 * no row exists.
 */
export function streamProvisioned(
  c: Context,
  workspaceId: string,
  run: (onProgress: (message: string) => void) => Promise<unknown>,
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
