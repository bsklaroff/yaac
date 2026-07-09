import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'

/**
 * `zValidator` with the daemon's error shape: validation failures answer
 * `{ error: { code: 'VALIDATION', message } }` (a `DaemonErrorBody`) with
 * the first issue's path + message, instead of zValidator's default
 * serialized-ZodError body — so the CLI's exit-code mapping and error
 * strings work the same as for `DaemonError` throws. Every route validates
 * through this wrapper.
 */
export const zv = <T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: { code: 'VALIDATION', message: firstIssueMessage(result.error) } }, 400)
    }
  })

/** `path: message` for the first issue (path omitted for top-level issues). */
function firstIssueMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0]
  if (!issue) return 'Validation error'
  const path = issue.path.map(String).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}
