/**
 * Narrow an untrusted parsed value (JSON from an agent, a record on disk)
 * without trusting its shape: each answers undefined for anything else.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
