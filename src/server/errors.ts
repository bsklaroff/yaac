import { HTTPException } from 'hono/http-exception'
import { ServerError, type ServerErrorBody } from '@/shared/errors'

/**
 * Convert any thrown value into the wire `ServerErrorBody` + HTTP status the
 * server responds with. The error taxonomy itself (`ServerError`, `ErrorCode`)
 * lives in `@/shared/errors` so the CLI and frontend can classify responses
 * without pulling in hono.
 */
export function toErrorBody(err: unknown): { status: number; body: ServerErrorBody } {
  if (err instanceof ServerError) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: err.message } },
    }
  }
  if (err instanceof HTTPException && err.status === 400) {
    return {
      status: 400,
      body: { error: { code: 'VALIDATION', message: err.message } },
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  // Best-effort classification for build-engine / cluster connection
  // failures so the CLI can render a clear "runtime unavailable" message.
  if (/podman|kubectl|kubernetes|connection refused.*6443/i.test(message)) {
    return {
      status: 503,
      body: { error: { code: 'RUNTIME_UNAVAILABLE', message } },
    }
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message } },
  }
}
