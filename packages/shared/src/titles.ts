/**
 * Workspace-title normalization, used for user-set, agent-set and generated
 * titles. Titles are display-only; the workspace's first message is the
 * fallback label.
 */
import { stripControlChars } from '#ansi'

export const MAX_TITLE_LENGTH = 120

/**
 * Normalize a title: collapse whitespace, drop control characters, cap the
 * length. Returns '' for a blank title (which clears the entry). An agent's
 * title is written by the workspace, and the CLI prints titles to a
 * terminal, so no escape may survive.
 */
export function normalizeTitle(raw: string): string {
  return stripControlChars(raw.replace(/\s+/g, ' ')).trim().slice(0, MAX_TITLE_LENGTH)
}
