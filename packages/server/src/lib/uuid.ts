const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether `s` is a uuid, i.e. safe to compare against a uuid column. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
