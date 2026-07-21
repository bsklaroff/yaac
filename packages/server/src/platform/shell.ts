/**
 * Shell-escape one token by single-quoting it (and escaping any embedded
 * single quotes), so the joined string survives an outer `sh -c`. The one
 * canonical POSIX quoter for server-built shell strings — import this
 * instead of redefining the escape dance per module.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
