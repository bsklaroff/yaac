import type { Context } from 'hono'
import { stream } from 'hono/streaming'
import { toErrorBody } from '#api/http/errors'

/**
 * Writes the NDJSON provisioning stream for the workspace create/restart
 * routes: `{type:'progress'}` events, then exactly one `{type:'result'}` or
 * `{type:'error'}`. Hono swallows errors thrown inside a stream callback, so
 * `run` failures are caught and emitted.
 *
 * `run` is a provision (`#domain/workspaces`), which already keeps the
 * provisioning row the webapp sees; this mirrors the same progress onto the
 * stream for the CLI.
 */
export function streamProvisioned(
  c: Context,
  run: (onProgress: (message: string) => void) => Promise<unknown>,
): Response {
  c.header('Content-Type', 'application/x-ndjson')
  return stream(c, async (s) => {
    const write = (event: unknown) => s.writeln(JSON.stringify(event))
    try {
      const result = await run((message) => { void write({ type: 'progress', message }) })
      await write({ type: 'result', result })
    } catch (err) {
      await write({ type: 'error', error: toErrorBody(err).body.error })
    }
  })
}
