/**
 * Workspace-title normalization, used for both user-set and generated
 * titles. Titles are display-only; the workspace's first message is the
 * fallback label.
 */

export const MAX_TITLE_LENGTH = 120

/** Normalize a user-supplied title: collapse whitespace, cap the length.
 *  Returns '' for a blank title (which clears the entry). */
export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}
