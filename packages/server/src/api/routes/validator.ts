import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'
import { ServerError } from '@yaac/shared/errors'

/**
 * `zValidator` that *throws* a `ServerError('VALIDATION')` on bad input rather
 * than returning an error response. `app.onError` then serializes it to the
 * same `{ error: { code: 'VALIDATION', message } }` (400) body as any other
 * thrown error — so validation joins the single throw→onError error path.
 *
 * Throwing (vs. the hook returning `c.json(...)`) also keeps the failure out
 * of the route's inferred response type, so `AppType` stays pure-success and
 * clients can read `res.json()` with no error-member union to narrow. Every
 * route validates through this wrapper.
 */
export const zv = <T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ServerError('VALIDATION', firstIssueMessage(result.error))
    }
  })

/** `path: message` for the first issue (path omitted for top-level issues). */
function firstIssueMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0]
  if (!issue) return 'Validation error'
  const path = issue.path.map(String).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}
