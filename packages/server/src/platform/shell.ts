/**
 * Shell-escape one token by single-quoting it (and escaping any embedded
 * single quotes), so the joined string survives an outer `sh -c`. The one
 * canonical POSIX quoter for server-built shell strings — import this
 * instead of redefining the escape dance per module.
 */
export function shellQuote(arg: string): string {
  return `'${shellEscape(arg)}'`
}

/**
 * The inner half of `shellQuote`: escape embedded single quotes without
 * adding the surrounding pair. For the many call sites that build a quoted
 * literal inside a larger template (`tmux … '${…}'`) and so supply the
 * quotes themselves.
 */
export function shellEscape(str: string): string {
  return str.replace(/'/g, `'\\''`)
}
