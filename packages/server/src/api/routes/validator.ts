import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'
import { ServerError } from '@yaac/shared/errors'

/**
 * `zValidator` that throws `ServerError('VALIDATION')` on bad input, so
 * `app.onError` serializes it like any other error (400). Throwing instead of
 * returning `c.json(...)` also keeps errors out of each route's inferred
 * response type, so clients read `res.json()` without narrowing. Every route
 * validates through this wrapper.
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
