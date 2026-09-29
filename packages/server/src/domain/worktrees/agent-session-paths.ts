import { resolveProjectPath, type SandboxFile } from '#runtime/agents'
import type { AgentSessionLinkRow } from '#db'

/** What resolving takes: the project and tool the path is recorded against,
 *  and the stored value. Every conversation row satisfies it. */
type RecordedTranscript = Pick<AgentSessionLinkRow, 'projectSlug' | 'tool' | 'transcriptPath'>

/**
 * The transcript a recorded conversation names, or undefined when this
 * install will not read it.
 *
 * The rows hold the column form — project-relative, the one form that stays
 * true wherever the data dir sits — and every reader wants a file it can open
 * under the tool's own home. Turning one into the other needs the disk
 * layout, which is the store's to know and not something a row can answer,
 * so the two forms meet here rather than inside `#db`.
 *
 * The single door, so a caller cannot forget the project or the tool:
 * `resolveProjectPath` refuses a stored value that is not under the recording
 * tool's home, and every reader degrades the same way on undefined — no
 * prompt, no last-activity.
 */
export function recordedTranscript(row: RecordedTranscript | undefined): SandboxFile | undefined {
  if (row?.transcriptPath === undefined) return undefined
  return resolveProjectPath(row.projectSlug, row.tool, row.transcriptPath)
}
