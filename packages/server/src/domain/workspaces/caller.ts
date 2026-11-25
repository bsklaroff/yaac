import { getProjectRow, getUser } from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { WorkspaceDelegate } from '@yaac/shared/types'
import { callingSession } from './calling-session'
import { resolveCreate } from './create'

/**
 * The delegate a workspace's `yaac-mama` call acts as, from the workspace
 * its transport identified and the session its agent claims
 * (`callingSession`): its project owner's, scoped to its project, its
 * ceiling that session's posture, or with no session the one a create
 * would resolve. A public site's release runs code that faces the
 * internet, so it may not act on yaac at all (docs/public-sites.md).
 */
export async function callingWorkspace(
  workspace: { workspaceId: string; projectId: string; siteId?: string },
  claimedSessionId: string | undefined,
): Promise<WorkspaceDelegate> {
  if (workspace.siteId !== undefined) throw new ServerError('FORBIDDEN', 'a public site\'s release may not call yaac')
  const { workspaceId, projectId } = workspace
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  const session = await callingSession(workspace, claimedSessionId)
  return {
    kind: 'delegate',
    userId: project.owner,
    login: (await getUser(project.owner))?.login ?? null,
    via: {
      kind: 'workspace',
      id: workspaceId,
      label: `workspace ${workspaceId.slice(0, 8)}`,
      ...(session?.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
    },
    projectId,
    ceiling: session?.permissionMode ?? (await resolveCreate(projectId, {})).permissionMode,
  }
}
