import { resolveProjectPath } from '#runtime/agents'
import type { SandboxFile } from '#runtime/agents'
import { getSessionRow, getWorkspaceRow, listWorkspaceRepos, type ConversationLinkRow } from '#db'

/** The row fields needed to resolve a stored transcript path. */
type RecordedTranscript = Pick<ConversationLinkRow, 'projectId' | 'workspaceId' | 'tool' | 'transcriptPath'>

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

/**
 * The directories a conversation's agent may have run in, relative to its
 * workspace root, the likeliest first: its session's, the workspace's
 * default (a conversation started by hand in a terminal has no session),
 * then the workspace's others. Where claude filed a transcript no row
 * records the path of is one of these (`sessionTranscriptPath`).
 */
export async function conversationCwds(
  link: Pick<ConversationLinkRow, 'projectId' | 'workspaceId' | 'sessionId'>,
): Promise<string[]> {
  const [session, workspace, checkouts] = await Promise.all([
    link.sessionId !== undefined ? getSessionRow(link.sessionId) : undefined,
    getWorkspaceRow(link.projectId, link.workspaceId),
    listWorkspaceRepos(link.workspaceId),
  ])
  return [...new Set([
    ...(session !== undefined ? [session.cwd] : []),
    workspace?.cwd ?? '',
    '',
    ...checkouts.map((c) => c.path),
  ])]
}

/** `rows` as `conversationFiles` takes them: each claude conversation with
 *  where its transcript may be filed, for when its recorded path is absent
 *  or stale. */
export function withCwds<R extends ConversationLinkRow>(rows: R[]): Promise<Array<R & { cwds?: string[] }>> {
  return Promise.all(rows.map(async (row) => (row.tool === 'claude' ? { ...row, cwds: await conversationCwds(row) } : row)))
}
