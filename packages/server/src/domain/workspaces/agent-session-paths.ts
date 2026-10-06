import { resolveProjectPath, type SandboxFile } from '#runtime/agents'
import type { AgentSessionLinkRow } from '#db'

/** The row fields needed to resolve a stored transcript path. */
type RecordedTranscript = Pick<AgentSessionLinkRow, 'projectId' | 'workspaceId' | 'tool' | 'transcriptPath'>

/**
 * The transcript file a recorded conversation names, or undefined when it
 * should not be read.
 *
 * Rows store the path project-relative, so it stays valid wherever the data
 * dir is. Resolving it needs the disk layout, which `#db` does not know.
 * `resolveProjectPath` refuses a path outside the tool's home or this
 * workspace's history; callers treat undefined as "no prompt, no last
 * activity".
 */
export function recordedTranscript(row: RecordedTranscript | undefined): SandboxFile | undefined {
  if (row?.transcriptPath === undefined) return undefined
  return resolveProjectPath(row.projectId, row.workspaceId, row.tool, row.transcriptPath)
}
