/**
 * Uniform error taxonomy the daemon returns on every non-2xx response.
 *
 * The CLI translates the `code` into a process exit status so that the
 * end-user experience of the old direct-to-lib CLI is preserved:
 *
 *   NOT_FOUND           → exit 1 (e.g. "No such session/project")
 *   VALIDATION          → exit 2 (input rejected — bad shape / unknown tool)
 *   CONFLICT            → exit 1 (e.g. duplicate `project add`)
 *   PODMAN_UNAVAILABLE  → exit 1 (the old "Failed to connect to Podman")
 *   AUTH_REQUIRED       → CLI invokes `auth update` inline and retries
 *   BAD_BEARER          → client re-resolves the lock and retries once
 *   INTERNAL            → exit 1 (everything else)
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'PODMAN_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'BAD_BEARER'
  | 'INTERNAL'

export interface DaemonErrorBody {
  error: {
    code: ErrorCode
    message: string
  }
}

export class DaemonError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number

  constructor(code: ErrorCode, message: string, httpStatus?: number) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus ?? defaultStatus(code)
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'NOT_FOUND': return 404
    case 'VALIDATION': return 400
    case 'CONFLICT': return 409
    case 'PODMAN_UNAVAILABLE': return 503
    case 'AUTH_REQUIRED': return 401
    case 'BAD_BEARER': return 401
    case 'INTERNAL': return 500
  }
}

export function toErrorBody(err: unknown): { status: number; body: DaemonErrorBody } {
  if (err instanceof DaemonError) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: err.message } },
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  // Best-effort classification for podman connection failures so the CLI
  // can render the old "Failed to connect to Podman" message.
  if (/podman|dockerode|ECONNREFUSED.*\/podman/i.test(message)) {
    return {
      status: 503,
      body: { error: { code: 'PODMAN_UNAVAILABLE', message } },
    }
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message } },
  }
}

export function exitCodeForError(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION': return 2
    default: return 1
  }
}
