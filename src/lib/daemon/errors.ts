import { HTTPException } from 'hono/http-exception'

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
  if (err instanceof HTTPException && err.status === 400) {
    return {
      status: 400,
      body: { error: { code: 'VALIDATION', message: err.message } },
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

/**
 * zValidator (used inline on each route) answers validation failures with
 * its own 400 shape: `{ success: false, error: { name, message } }` where
 * `error.message` is a JSON-stringified ZodError issues array. Reshape it
 * into the daemon's `DaemonErrorBody` so the CLI exit-code mapping still
 * fires on VALIDATION. Returns null for anything that isn't that shape.
 */
export function rewriteZValidatorBody(raw: unknown): DaemonErrorBody | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { success?: unknown; error?: unknown }
  if (r.success !== false || !r.error || typeof r.error !== 'object') return null
  const errMessage = (r.error as { message?: unknown }).message
  let message = 'Validation error'
  if (typeof errMessage === 'string') {
    try {
      const issues = JSON.parse(errMessage) as Array<{ path?: unknown; message?: unknown }>
      const issue = Array.isArray(issues) ? issues[0] : undefined
      if (issue && typeof issue.message === 'string') {
        const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : ''
        message = path ? `${path}: ${issue.message}` : issue.message
      }
    } catch {
      message = errMessage
    }
  }
  return { error: { code: 'VALIDATION', message } }
}

export function exitCodeForError(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION': return 2
    default: return 1
  }
}
