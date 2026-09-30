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

/**
 * Remove a project: its workspaces and bytes (`purgeProjectBytes`), then its
 * rows. Throws `NOT_FOUND` if it does not exist. The project row goes last,
 * so a failed removal leaves a project that can still be listed and removed
 * again. Lives here rather than in #domain/projects to avoid an import
 * cycle.
 */
export async function removeProject(slug: string): Promise<void> {
  const row = await getProjectRow(slug)
  if (!row) throw new ServerError('NOT_FOUND', `project ${slug} not found`)

  await purgeProjectBytes({ slug, id: row.id })
  // The macOS Keychain item containerless claude keys on the tool home path;
  // otherwise a new project with this slug would find it. No-op elsewhere.
  dropProjectClaudeKeychainItem(slug)

  await deleteProjectWorkspaces(slug)
  await deleteProjectAgentSessions(slug)
  await deleteProjectWorkspaceGroups(slug)
  await deleteProjectQueuedWorkspaces(slug)
  await deleteProjectDraftWorkspaces(slug)
  await deleteProjectEnvVars(slug)
  await deleteProjectRow(slug)
}
