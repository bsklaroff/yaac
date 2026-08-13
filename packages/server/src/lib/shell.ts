import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Run a program on THIS machine and await its output.
 *
 * The host-side counterpart to the exec helpers in `#drivers/k8s/substrate` and
 * `#drivers/k8s/container`, which address a pod and a container runtime
 * respectively. A module that runs a plain local binary — a pinned
 * llama.cpp, a git subcommand — belongs here, and reaching for one of those
 * instead would tie it to a substrate it does not use.
 */
export const execFileAsync = promisify(execFile)

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
