import { purgeProjectBytes } from './project-purge'
import {
  deleteProjectAgentSessions,
  deleteProjectDraftWorkspaces,
  deleteProjectEnvVars,
  deleteProjectQueuedWorkspaces,
  deleteProjectRow,
  deleteProjectWorkspaceGroups,
  deleteProjectWorkspaces,
  getProjectRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { dropProjectClaudeKeychainItem } from '@yaac/shared/tool-auth'
import { authorizeProject, type Actor } from '#domain/access'

/**
 * Remove a project: its workspaces and bytes (`purgeProjectBytes`), then its
 * rows. Throws `NOT_FOUND` if it does not exist. The project row goes last,
 * so a failed removal leaves a project that can still be listed and removed
 * again. Lives here rather than in #domain/projects to avoid an import
 * cycle.
 */
export async function removeProject(principal: Actor, projectId: string): Promise<void> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)

  await purgeProjectBytes(projectId)
  // The macOS Keychain item containerless claude keys on the tool home path.
  // No-op elsewhere.
  dropProjectClaudeKeychainItem(projectId)

  await deleteProjectWorkspaces(projectId)
  await deleteProjectAgentSessions(projectId)
  await deleteProjectWorkspaceGroups(projectId)
  await deleteProjectQueuedWorkspaces(projectId)
  await deleteProjectDraftWorkspaces(projectId)
  await deleteProjectEnvVars(projectId)
  await deleteProjectRow(projectId)
}
