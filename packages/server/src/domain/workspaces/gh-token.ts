import { getProjectRow, listWorkspaceRepos } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { canUseRepo, resolveRepoCredential } from '#domain/repos'
import { workspacesSandboxed } from '#drivers/driver'
import { isGitHubHost } from '@yaac/shared/credentials'
import { ServerError } from '@yaac/shared/errors'
import { parseGitRemote } from '@yaac/shared/git-remote'
import { ghTokenPlaceholder } from '@yaac/shared/tool-auth'
import { resolveWorkspaceRecord } from './resolve'

/**
 * The `GH_TOKEN` value that stands for one of a workspace's project's
 * repos, which `yaac-mama as-repo <repo> -- <command>` runs one command
 * with (docs/project-repos.md "GH_TOKEN"), for that workspace's own
 * delegate alone: the repo `ref` names by its folder in the project, its
 * id, or its checkout's path in the workspace. With a sandbox it is that
 * repo's placeholder, which the proxy swaps only while the project's link
 * allows it, so one that does not is refused here; without one it is the
 * repo's token, since the workspace holds every credential anyway. Only an
 * https GitHub repo has one.
 */
export async function workspaceRepoToken(actor: Actor, idOrPrefix: string, ref: string): Promise<string> {
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  await authorizeProject(actor, projectId, 'delegate')
  if (actor.kind !== 'delegate' || actor.via.kind !== 'workspace' || actor.via.id !== workspaceId) {
    throw new ServerError('FORBIDDEN', `only workspace ${workspaceId.slice(0, 8)} itself may run as one of its repos`)
  }
  const project = await getProjectRow(projectId)
  const checkedOut = (await listWorkspaceRepos(workspaceId)).find((c) => c.path === ref)
  const link = project?.repos.find((l) => l.dir === ref) ?? project?.repos.find((l) => l.repo.id === ref)
    ?? project?.repos.find((l) => l.repo.id === checkedOut?.repoId)
  if (project === undefined || link === undefined) throw new ServerError('NOT_FOUND', `this project has no repo "${ref}"`)
  const { repo } = link
  // A hosted repo's remote is yaac's own, which is not a URL this parses.
  if (repo.hosted || parseGitRemote(repo.remoteUrl).scheme !== 'https' || !isGitHubHost(parseGitRemote(repo.remoteUrl).host)) {
    throw new ServerError('VALIDATION', `${link.dir} is not an https GitHub repo, so it has no token gh could use`)
  }
  if (workspacesSandboxed()) {
    if (link.readOnly || repo.readOnly) throw new ServerError('FORBIDDEN', `${link.dir} is read-only, so its token is never GH_TOKEN`)
    if (!link.ghToken) throw new ServerError('FORBIDDEN', `this project does not allow ${link.dir}'s token as GH_TOKEN`)
    return ghTokenPlaceholder(repo.id)
  }
  const credential = await canUseRepo(project.owner, repo) ? await resolveRepoCredential(repo) : null
  if (credential?.kind !== 'https') throw new ServerError('NOT_FOUND', `${link.dir} has no git credential`)
  return credential.token
}
