/**
 * Dependency-free ANSI/control-character stripping, shared by everything
 * that ingests raw CLI output (tool login/install PTYs, podman build logs).
 */

const ANSI_RE = /\x1b\[[0-9;?]*[0-9A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|[\x00-\x08\x0b-\x1f]/g

/** Strip ANSI escapes and control characters (newlines survive). */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '')
}
