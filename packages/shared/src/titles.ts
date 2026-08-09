/**
 * Worktree-title normalization, shared by the rename route, the worktree store
 * that persists the result, and the titles feature that generates one from a
 * worktree's first message. Titles are
 * display-only: the captured first message stays the fallback label
 * everywhere, and both live on the worktree row.
 */

export const MAX_TITLE_LENGTH = 120

/** Normalize a user-supplied title: collapse whitespace, cap the length.
 *  Returns '' for a blank title (which clears the entry). */
export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}
