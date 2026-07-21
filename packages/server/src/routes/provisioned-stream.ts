import type { Context } from 'hono'
import { stream } from 'hono/streaming'
import { runProvisioned } from '#features/sessions/provisioning'
import { toErrorBody } from '#http/errors'

/**
 * Writer side of the NDJSON provisioning streams shared by the session
 * create/restart routes: `{type:'progress'}` events followed by exactly one
 * terminal `{type:'result'}` or `{type:'error'}` (errors thrown inside a hono
 * stream callback are swallowed, so `run` failures are caught and emitted).
 *
 * The provisioning-registry row lifecycle (webapp, snapshot-driven) is
 * `runProvisioned`'s job — this layer only mirrors the same progress and
 * outcome onto the NDJSON stream (CLI), keeping both in sync. Registering the
 * `sessionId` row is the caller's job (create only registers after its prewarm
 * fast path misses; restart only when the webapp supplied the row's project) —
 * all registry calls are no-ops while no row exists.
 */
export function streamProvisioned(
  c: Context,
  sessionId: string,
  run: (onProgress: (message: string) => void) => Promise<unknown>,
): Response {
  c.header('Content-Type', 'application/x-ndjson')
  return stream(c, async (s) => {
    const write = (event: unknown) => s.writeln(JSON.stringify(event))
    try {
      const result = await runProvisioned(sessionId, (onProgress) =>
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
