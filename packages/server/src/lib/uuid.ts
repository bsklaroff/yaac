const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether `s` is a uuid — what a uuid column may be compared against
 *  without a type error, and what an id minted as one must look like. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
