import type { Context } from 'hono'
import { stream } from 'hono/streaming'
import {
  updateProvisioningMessage,
  failProvisioning,
  removeProvisioning,
} from '@/daemon/provisioning'
import { toErrorBody } from '@/daemon/errors'
import { notifySessionListChanged } from '@/daemon/sessions-changed'

/**
 * Writer side of the NDJSON provisioning streams shared by the session
 * create/restart routes: `{type:'progress'}` events followed by exactly one
 * terminal `{type:'result'}` or `{type:'error'}` (errors thrown inside a hono
 * stream callback are swallowed, so `run` failures are caught and emitted).
 *
 * `run` does the actual provisioning and gets an `onProgress` that mirrors
 * each step into the provisioning registry (webapp, snapshot-driven) AND the
 * NDJSON stream (CLI), keeping both in sync. Registering the `sessionId` row
 * is the caller's job (create only registers after its prewarm fast path
 * misses; restart only when the webapp supplied the row's project) — all
 * registry calls here are no-ops while no row exists.
 */
export function streamProvisioned(
  c: Context,
  sessionId: string,
  run: (onProgress: (message: string) => void) => Promise<unknown>,
): Response {
  c.header('Content-Type', 'application/x-ndjson')
  return stream(c, async (s) => {
    const write = (event: unknown) => s.writeln(JSON.stringify(event))
    const onProgress = (message: string): void => {
      updateProvisioningMessage(sessionId, message)
      void write({ type: 'progress', message })
    }
    try {
      const result = await run(onProgress)
      // Setup is complete — drop the provisioning row (its notify pushes the
      // snapshot that swaps it for the now-ready session; buildSnapshot hides
      // the session while the row exists). Before the result write, so a
      // client gone mid-provision can't leave the row stuck.
      removeProvisioning(sessionId)
      await write({ type: 'result', result })
      notifySessionListChanged()
    } catch (err) {
      const { body: errBody } = toErrorBody(err)
      failProvisioning(sessionId, errBody.error.message)
      await write({ type: 'error', error: errBody.error })
    }
  })
}
