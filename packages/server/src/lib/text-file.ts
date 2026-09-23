/**
 * The one rule for "is this an editable text file", shared by the build-files
 * editor and the worktree file editor.
 */

/** Files at most this size are read and written inline as text. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024

/**
 * Binary when there is a NUL in the first 8,000 bytes (git's heuristic) or
 * the bytes are not valid UTF-8. Pass `partial` when `bytes` is only a
 * file's head, so a multi-byte character cut at the end is not held
 * against it.
 */
export function isBinaryContent(bytes: Uint8Array, partial = false): boolean {
  if (bytes.subarray(0, 8000).includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial })
    return false
  } catch {
    return true
  }
}
