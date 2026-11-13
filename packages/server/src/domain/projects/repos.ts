import {
  getProjectRow,
  getRepo,
  linkProjectRepo,
  listNamedWorkflows,
  listProjectSites,
  setProjectRepoOrder,
  siteBuiltFrom,
  unlinkProjectRepo,
  updateProjectRepo,
  type ProjectRepoLink,
  type ProjectRow,
  type RepoRow,
} from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { addRepo, assertCanUseRepo, createHostedRepo } from '#domain/repos'
import { workspaceDriver } from '#drivers/driver'
import { ServerError } from '@yaac/shared/errors'
import { parseGitRemote } from '@yaac/shared/git-remote'
import { projectNameFor } from '@yaac/shared/project-name'
import { MAX_PROJECT_REPOS, REPO_DIR_RE } from '@yaac/shared/types'
import { isUuid } from '#lib/uuid'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { allowRepoHost } from './allowlist'

/*
 * Which repos a project links (docs/project-repos.md): linking one by URL,
 * by id or as a new hosted repo, unlinking, and each link's folder name,
 * order and k8s-only flags. Unlinking never deletes a repo or a workspace.
 */

/** What a link is made to: a remote the owner reaches with one of their
 *  credentials, a repo they may already use, or a new one yaac hosts. */
export type RepoToLink =
  | { remoteUrl: string; credentialId: string }
  | { repoId: string }
  | { hosted: true }

/** The link a client's `ref` names in a project: by its folder, else by
 *  the repo's id. */
export function projectRepo(project: ProjectRow, ref: string): ProjectRepoLink {
  const link = project.repos.find((l) => l.dir === ref) ?? project.repos.find((l) => l.repo.id === ref)
  if (!link) throw new ServerError('NOT_FOUND', `project "${project.name}" has no repo "${ref}"`)
  return link
}

/**
 * The link a repo-scoped request means: the one `ref` names, or with no
 * `ref` the project's only repo. A project with several needs the `ref`.
 */
export function repoOfProject(project: ProjectRow, ref?: string): ProjectRepoLink {
  if (ref !== undefined) return projectRepo(project, ref)
  if (project.repos.length === 1) return project.repos[0]
  throw new ServerError('VALIDATION', project.repos.length === 0
    ? `project "${project.name}" has no repos`
    : `project "${project.name}" has several repos; name one of: ${project.repos.map((l) => l.dir).join(', ')}`)
}

async function ownProject(principal: Actor, projectId: string): Promise<ProjectRow> {
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  return project
}

function checkDir(project: ProjectRow, dir: string): void {
  if (!REPO_DIR_RE.test(dir)) {
    throw new ServerError('VALIDATION', `"${dir}" is not a usable folder name: use letters, digits, ".", "_" and "-"`)
  }
  if (project.repos.some((l) => l.dir === dir)) {
    throw new ServerError('CONFLICT', `project "${project.name}" already has a repo in "${dir}"`)
  }
}

/** A folder name no repo of the project uses, starting from `wanted`. */
function freeDir(project: ProjectRow, wanted: string): string {
  const taken = new Set(project.repos.map((l) => l.dir))
  for (let n = 1; ; n++) {
    const dir = n === 1 ? wanted : `${wanted}-${n}`
    if (!taken.has(dir)) return dir
  }
}

/**
 * Refuse a link the project has no room for: one past `MAX_PROJECT_REPOS`,
 * one into a folder a repo already takes, or one to a repo it already
 * links (`linked`).
 */
function checkLinkable(project: ProjectRow, dir: string | undefined, linked: (l: ProjectRepoLink) => boolean): void {
  if (project.repos.length >= MAX_PROJECT_REPOS) {
    throw new ServerError('VALIDATION', `a project links at most ${MAX_PROJECT_REPOS} repos`)
  }
  if (dir !== undefined) checkDir(project, dir)
  if (project.repos.some(linked)) throw new ServerError('CONFLICT', `project "${project.name}" already links that repo`)
}

/** Serializes the last check and the write of each link's folder in a
 *  project. */
const perProject = createKeyedMutex()

/**
 * Link a repo into a project under `dir`, by default the repo's name, and
 * add its host to the project's allowlist when the list leaves it out.
 * Answers the link, with the host key trusted for a fresh ssh clone and the
 * host added to the allowlist, if any.
 *
 * A clone can take minutes, in which another link may land, so the link is
 * checked before the repo is cloned or made (to fail fast) and again, on
 * the project as it then is, under a per-project lock before it is written.
 */
export async function addProjectRepo(
  principal: Actor,
  projectId: string,
  what: RepoToLink,
  dir?: string,
): Promise<{ repoId: string; dir: string; knownHostsEntry: string | null; allowedHost: string | null }> {
  const project = await ownProject(principal, projectId)
  checkLinkable(project, dir, (l) => 'remoteUrl' in what
    ? l.repo.owner === project.owner && l.repo.remoteUrl === what.remoteUrl
    : 'repoId' in what && l.repo.id === what.repoId)
  let knownHostsEntry: string | null = null
  let repo: RepoRow
  if ('remoteUrl' in what) {
    const added = await addRepo(project.owner, what.remoteUrl, what.credentialId)
    repo = added.repo
    knownHostsEntry = added.knownHostsEntry
  } else if ('repoId' in what) {
    const found = isUuid(what.repoId) ? await getRepo(what.repoId) : undefined
    if (!found) throw new ServerError('NOT_FOUND', `repo ${what.repoId} not found`)
    await assertCanUseRepo(project.owner, found)
    repo = found
  } else {
    repo = await createHostedRepo(project.owner)
  }
  return perProject(projectId, async () => {
    const current = await ownProject(principal, projectId)
    checkLinkable(current, dir, (l) => l.repo.id === repo.id)
    const named = repo.hosted ? current.name : projectNameFor(parseGitRemote(repo.remoteUrl).path) || 'repo'
    const at = dir ?? freeDir(current, named)
    await linkProjectRepo(projectId, repo.id, at)
    return { repoId: repo.id, dir: at, knownHostsEntry, allowedHost: await allowRepoHost(projectId, repo) }
  })
}

/**
 * Unlink a repo from a project. The repo stays among its owner's, and every
 * workspace keeps its checkout of it, though the project's workspaces can
 * no longer fetch or push it. Refused while a site of the project is built
 * from the repo or a named workflow names it, since every later release or
 * launch would be refused (an init workflow's skipped without a word).
 */
export async function removeProjectRepo(principal: Actor, projectId: string, ref: string): Promise<void> {
  const link = projectRepo(await ownProject(principal, projectId), ref)
  const sites = (await listProjectSites(projectId)).filter((s) => siteBuiltFrom(s, link.repo.id))
  if (sites.length > 0) {
    throw new ServerError('CONFLICT', `site ${sites.map((s) => `"${s.name}"`).join(', ')} is built from `
      + `${link.dir}; delete the site first`)
  }
  const flows = (await listNamedWorkflows(projectId)).filter((w) => w.workflow.repos.includes(link.repo.id))
  if (flows.length > 0) {
    throw new ServerError('CONFLICT', `workflow ${flows.map((w) => `"${w.name}"`).join(', ')} runs in `
      + `${link.dir}; edit or delete the workflow first`)
  }
  await unlinkProjectRepo(link.repo.id, projectId)
}

/**
 * Change a link: the folder its checkout takes in workspaces created from
 * now on, or the k8s-only `readOnly` and `ghToken` flags, which a
 * containerless install refuses since a workspace there holds every
 * credential (docs/project-repos.md "Read-only repos"). Runs under the
 * lock `addProjectRepo` takes, so a rename and a link cannot both take one
 * folder.
 */
export async function updateProjectRepoLink(
  principal: Actor,
  projectId: string,
  ref: string,
  set: { dir?: string; readOnly?: boolean; ghToken?: boolean },
): Promise<void> {
  await perProject(projectId, async () => {
    const project = await ownProject(principal, projectId)
    const link = projectRepo(project, ref)
    if ((set.readOnly !== undefined || set.ghToken !== undefined) && workspaceDriver().kind === 'containerless') {
      throw new ServerError('NOT_SUPPORTED', 'read-only repos and the GH_TOKEN setting need the k8s driver: '
        + 'without a sandbox a workspace holds every credential')
    }
    if (set.dir !== undefined && set.dir !== link.dir) {
      checkDir(project, set.dir)
      // A replacement release is a fresh checkout under the folder's current
      // name, and the site's steps name its folders. A replacement repeats
      // the last release's layout, so a site edited down to one repo still
      // nests it until it deploys again.
      const nesting = (await listProjectSites(projectId)).filter((s) => siteBuiltFrom(s, link.repo.id)
        && (s.repos.length > 1 || Object.keys(s.releaseCommits ?? {}).length > 1))
      if (nesting.length > 0) {
        throw new ServerError('CONFLICT', `site ${nesting.map((s) => `"${s.name}"`).join(', ')} keeps ${link.dir} in its `
          + 'folder; take the repo off the site first')
      }
    }
    await updateProjectRepo(projectId, link.repo.id, set)
  })
}

/** List a project's repos in the order `refs` names them. */
export async function reorderProjectRepos(principal: Actor, projectId: string, refs: string[]): Promise<void> {
  const project = await ownProject(principal, projectId)
  await setProjectRepoOrder(projectId, refs.map((ref) => projectRepo(project, ref).repo.id))
}
