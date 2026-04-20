import { DaemonError } from '@/lib/daemon/errors'

/**
 * Parse the request body as a JSON object. Throws `VALIDATION` for
 * anything that isn't `{...}` — arrays and primitives are rejected so
 * route handlers can treat the result as a keyed record.
 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    throw new DaemonError('VALIDATION', 'Malformed JSON body.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DaemonError('VALIDATION', 'Expected a JSON object body.')
  }
  return parsed as Record<string, unknown>
}

export function readStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new DaemonError('VALIDATION', `Expected ${field} to be an array of strings.`)
  }
  return value
}
