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

export function defaultStatus(code: ErrorCode): number {
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
