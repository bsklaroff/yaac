import { zValidator } from '@hono/zod-validator'
import { bodyLimit } from 'hono/body-limit'
import type { MiddlewareHandler, ValidationTargets } from 'hono'
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

/**
 * `bodyLimit` for a route that validates a JSON body with `zv`, refusing an
 * oversized body as `TOO_LARGE` (413). The body is read here, inside the
 * limit: a body that declares no length is counted as it streams, and the
 * JSON validator would report the limit's error as malformed JSON (400).
 * The validator then parses the text this read cached.
 */
export function jsonBodyLimit(maxSize: number, message: string): MiddlewareHandler {
  const tooLarge = (): never => { throw new ServerError('TOO_LARGE', message) }
  const limit = bodyLimit({ maxSize, onError: tooLarge })
  return (c, next) => limit(c, async () => {
    await c.req.text().catch((err: unknown) => {
      if (err instanceof Error && err.name === 'BodyLimitError') tooLarge()
      throw err
    })
    await next()
  })
}

/** `path: message` for the first issue (path omitted for top-level issues). */
function firstIssueMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0]
  if (!issue) return 'Validation error'
  const path = issue.path.map(String).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}
