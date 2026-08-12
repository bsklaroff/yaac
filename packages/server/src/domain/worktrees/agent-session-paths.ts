import { resolveProjectPath } from '#runtime/agents'
import type { AgentSessionLinkRow } from '#db'

/** What resolving takes: the project the path is recorded against, and the
 *  stored value. Every conversation row satisfies it. */
type RecordedTranscript = Pick<AgentSessionLinkRow, 'projectSlug' | 'transcriptPath'>

/**
 * Where a recorded conversation's transcript actually is, or undefined when
 * this install cannot resolve it.
 *
 * The rows hold the column form — project-relative, the one form that stays
 * true wherever the data dir sits — and every reader that opens or stats a
 * transcript wants an absolute path. Turning one into the other needs the
 * disk layout, which is the store's to know and not something a row can
 * answer, so the two forms meet here rather than inside `#db`.
 *
 * The single door, so a caller cannot forget the project slug or quietly
 * stat a relative path: `resolveProjectPath` refuses (and logs) a stored
 * value that isn't project-relative, and every reader degrades the same way
 * on undefined — no prompt, no last-activity.
 */
export function absoluteTranscriptPath(row: RecordedTranscript | undefined): string | undefined {
  if (row?.transcriptPath === undefined) return undefined
  return resolveProjectPath(row.projectSlug, row.transcriptPath)
}
