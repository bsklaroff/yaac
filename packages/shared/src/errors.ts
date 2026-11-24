/**
 * The error codes the server returns in every non-2xx response body.
 * Clients receive them as a `ServerError`.
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RUNTIME_UNAVAILABLE'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'APPROVAL_REQUIRED'
  | 'BAD_HOST'
  | 'NOT_SUPPORTED'
  | 'MISSING_TOOL'
  | 'VOLUME_HELD'
  | 'CHECKPOINT_UNRESTORABLE'
  | 'PUSH_REFUSED'
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
    case 'UNAUTHENTICATED': return 401
    // The caller is known but does not own the resource.
    case 'FORBIDDEN': return 403
    // A privileged launch no person has approved (docs/workflows.md
    // "Approvals"): a person launching it approves it.
    case 'APPROVAL_REQUIRED': return 403
    case 'BAD_HOST': return 403
    // This server's driver lacks the feature (e.g. image builds under
    // containerless).
    case 'NOT_SUPPORTED': return 501
    // A tool this host has not installed; the webapp offers to install it.
    case 'MISSING_TOOL': return 400
    // A launch's volume is attached to another running workspace; the
    // webapp offers to start without it.
    case 'VOLUME_HELD': return 409
    // A restart whose newest checkpoint cannot be restored; the webapp
    // offers to restart from the newest readable state (`restoreNewest`).
    case 'CHECKPOINT_UNRESTORABLE': return 409
    // An add of a remote its credential cannot push to; the webapp offers
    // to add it as a fork or read-only (docs/repo-forks.md "Push access").
    case 'PUSH_REFUSED': return 403
    // Refused rather than silently truncated.
    case 'TOO_LARGE': return 413
    case 'INTERNAL': return 500
  }
}
