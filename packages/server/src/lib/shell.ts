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

/**
 * A `NAME="<json>"` assignment to prefix a launch command with, for the
 * several tools whose configuration arrives as a JSON environment variable
 * (`OPENCODE_PERMISSION`, `CODEX_CONFIG`, `OPENCODE_CONFIG_CONTENT`).
 *
 * Double-quoted with escaped inner quotes rather than single-quoted, because
 * every one of these is embedded in `respawn-window '<cmd>'` — a single quote
 * would end the wrapper early — and bare `{...}` would hit zsh brace
 * expansion. Serialized rather than hand-written so the escaping cannot drift
 * from the shape.
 *
 * A value whose JSON contains a single quote is refused rather than escaped:
 * nothing that reaches here has one (model ids are `MODEL_RE`, posture rules
 * are literals), and the alternative is a quoting dance that would have to be
 * correct in two shells at once.
 */
export function envJsonAssignment(name: string, value: unknown): string {
  const json = JSON.stringify(value)
  if (json.includes("'")) {
    throw new Error(`${name} value contains a single quote, which cannot survive the launch wrapper`)
  }
  return `${name}="${json.replace(/"/g, '\\"')}"`
}
