/**
 * Title normalization, shared by the rename route, the model-generated
 * title path, and the session store that persists the result. Titles are
 * display-only: the captured first message stays the fallback label
 * everywhere, and both live on the session row.
 */

export const MAX_TITLE_LENGTH = 120

/** Normalize a user-supplied title: collapse whitespace, cap the length.
 *  Returns '' for a blank title (which clears the entry). */
export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}
