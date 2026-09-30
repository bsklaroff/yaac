import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Run a local program and await its output. Use this for plain host
 * binaries (llama.cpp, git) rather than the pod and container-runtime exec
 * helpers in `#drivers/k8s/*`.
 */
export const execFileAsync = promisify(execFile)

/**
 * Single-quote one token (escaping embedded single quotes) so it survives
 * an outer `sh -c`. The canonical quoter for server-built shell strings.
 */
export function shellQuote(arg: string): string {
  return `'${shellEscape(arg)}'`
}

/**
 * Escape embedded single quotes without adding the surrounding pair, for
 * templates that supply their own quotes (`tmux … '${…}'`).
 */
export function shellEscape(str: string): string {
  return str.replace(/'/g, `'\\''`)
}

/**
 * `str` as one double-quoted word in which the shell expands nothing, for a
 * launch argument whose `$VAR` the program itself should expand. Single
 * quotes are refused, as in `envJsonAssignment`.
 */
export function doubleQuoted(str: string): string {
  if (str.includes("'")) {
    throw new Error('value contains a single quote, which cannot survive the launch wrapper')
  }
  return `"${str.replace(/[\\"$`]/g, '\\$&')}"`
}

/**
 * A `NAME="<json>"` prefix for a launch command, for tools configured
 * through a JSON env var (`OPENCODE_PERMISSION`, `CODEX_CONFIG`,
 * `OPENCODE_CONFIG_CONTENT`).
 *
 * Double-quoted because these are embedded in `respawn-window '<cmd>'`,
 * where a single quote would end the wrapper, and bare `{...}` would hit
 * zsh brace expansion. JSON containing a single quote is refused; no
 * current value has one (model ids match `MODEL_RE`, posture rules are
 * literals).
 */
export function envJsonAssignment(name: string, value: unknown): string {
  const json = JSON.stringify(value)
  if (json.includes("'")) {
    throw new Error(`${name} value contains a single quote, which cannot survive the launch wrapper`)
  }
  return `${name}="${json.replace(/"/g, '\\"')}"`
}
