import { HTTPException } from 'hono/http-exception'

/**
 * Uniform error taxonomy the server returns on every non-2xx response.
 * The fetch adapter reads `AUTH_REQUIRED` / `BAD_BEARER` to drive its
 * retry logic; all other codes surface as plain `Error` messages.
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RUNTIME_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'AUTH_AGENT_DISCONNECTED'
  | 'BAD_BEARER'
  | 'INTERNAL'

export interface ServerErrorBody {
  error: {
    code: ErrorCode
    message: string
  }
}

export class ServerError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.httpStatus = defaultStatus(code)
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'NOT_FOUND': return 404
    case 'VALIDATION': return 400
    case 'CONFLICT': return 409
    case 'RUNTIME_UNAVAILABLE': return 503
    case 'AUTH_REQUIRED': return 401
    case 'AUTH_AGENT_DISCONNECTED': return 503
    case 'BAD_BEARER': return 401
    case 'INTERNAL': return 500
  }
}

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

