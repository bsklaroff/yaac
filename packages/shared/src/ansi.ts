/** ANSI and control-character stripping for raw CLI output. */

const ANSI_RE = /\x1b\[[0-9;?]*[0-9A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|[\x00-\x08\x0b-\x1f]/g

/** Strip ANSI escapes and control characters (newlines survive). */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '')
}
