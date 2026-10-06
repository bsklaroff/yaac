/** ANSI and control-character stripping for raw CLI output. */

const ANSI_RE = /\x1b\[[0-9;?]*[0-9A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|[\x00-\x08\x0b-\x1f]/g

/** Strip ANSI escapes and control characters (newlines survive). */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '')
}

/**
 * Drop every control character but newline and tab: C0, DEL and C1. For
 * text bound for a terminal, where an escape could start a sequence the
 * terminal acts on (ending a bracketed paste, setting the title or the
 * clipboard, or asking for a reply typed back as input).
 */
export function stripControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}
