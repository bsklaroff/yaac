/**
 * The error codes the server returns in every non-2xx response body.
 * Clients receive them as a `ServerError`.
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RUNTIME_UNAVAILABLE'
  | 'AUTH_AGENT_DISCONNECTED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'BAD_HOST'
  | 'NOT_SUPPORTED'
  | 'MISSING_TOOL'
  | 'TOO_LARGE'
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
    case 'AUTH_AGENT_DISCONNECTED': return 503
    case 'UNAUTHENTICATED': return 401
    // The caller is known but does not own the resource.
    case 'FORBIDDEN': return 403
    case 'BAD_HOST': return 403
    // This server's driver lacks the feature (e.g. image builds under
    // containerless).
    case 'NOT_SUPPORTED': return 501
    // A tool this host has not installed; the webapp offers to install it.
    case 'MISSING_TOOL': return 400
    // Refused rather than silently truncated.
    case 'TOO_LARGE': return 413
    case 'INTERNAL': return 500
  }
}
