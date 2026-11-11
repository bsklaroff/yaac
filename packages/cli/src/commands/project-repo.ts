import { api, projectRepoOf, resolveGitCredentialId, resolveProject, resolveRepo } from '#commands/api'
import { repoRemote } from '#commands/project-list'
import { printTable } from '#commands/table'
import { onOff } from '#commands/config-launch-settings'

/**
 * `yaac project repo …`: which repos a project links
 * (docs/project-repos.md). A repo is named by its folder in the project, or
 * its id. Unlinking deletes neither the repo nor any workspace's checkout
 * of it.
 */

export interface ProjectRepoAddOptions {
  /** Link a repo the project's owner already has, or was shared. */
  repoId?: string
  /** Link a new, empty repo yaac hosts. */
  hosted?: boolean
  /** The folder its checkout takes; by default the repo's name. */
  dir?: string
}

/** Link a repo into a project: a remote cloned with a credential, a repo
 *  its owner may already use, or a new one yaac hosts. */
export async function projectRepoAdd(
  project: string,
  remoteUrl: string | undefined,
  credential: string | undefined,
  opts: ProjectRepoAddOptions,
): Promise<void> {
  const ways = [remoteUrl !== undefined, opts.repoId !== undefined, opts.hosted === true].filter(Boolean).length
  if (ways !== 1 || (remoteUrl !== undefined && credential === undefined)) {
    throw new Error('Give one of: <remote-url> <credential>, --repo-id <id>, or --hosted.')
  }
  const summary = await resolveProject(project)
  const what = remoteUrl !== undefined
    ? { remoteUrl, credentialId: await resolveGitCredentialId(credential ?? '') }
    : opts.repoId !== undefined ? { repoId: (await resolveRepo(opts.repoId)).id } : { hosted: true as const }
  const added = await api.project[':projectId'].repo.$post({
    param: { projectId: summary.id },
    json: { ...what, ...(opts.dir !== undefined ? { dir: opts.dir } : {}) },
  })
  console.log(`Project "${summary.name}" now links repo ${added.repoId} in the folder ${added.dir}. `
    + 'Workspaces created from now on can start with it.')
  if (added.knownHostsEntry !== null) console.log(`Host key trusted: ${added.knownHostsEntry}`)
}

/** Unlink a repo from a project. */
export async function projectRepoRemove(project: string, repo: string): Promise<void> {
  const summary = await resolveProject(project)
  const link = projectRepoOf(summary, repo)
  await api.project[':projectId'].repo[':repo'].$delete({ param: { projectId: summary.id, repo: link.id } })
  console.log(`Project "${summary.name}" no longer links ${link.dir}. The repo stays among its owner's `
    + '(see `yaac repo list`), and workspaces keep their checkouts of it.')
}

/** A project's repos, in order, with each link's settings. */
export async function projectRepoList(project: string): Promise<void> {
  const summary = await resolveProject(project)
  if (summary.repos.length === 0) {
    console.log(`Project "${summary.name}" links no repos. Add one with \`yaac project repo add\`.`)
    return
  }
  const { driver } = await api.health.$get()
  const k8s = driver === 'k8s'
  printTable(
    [
      { header: 'DIR' }, { header: 'REPO' }, { header: 'CREDENTIAL' },
      { header: 'READ-ONLY', optional: true }, { header: 'GH_TOKEN', optional: true }, { header: 'REMOTE' },
    ],
    summary.repos.map((r) => [
      r.dir,
      r.id.slice(0, 8),
      r.hosted ? '(none needed)' : r.gitCredential?.name ?? '(none)',
      // Neither setting exists without a sandbox.
      k8s ? onOff(r.readOnly) : '',
      k8s ? onOff(r.ghToken && !r.readOnly) : '',
      repoRemote(r),
    ]),
  )
}

/** Change the folder a repo's checkout takes in workspaces created from
 *  now on. */
export async function projectRepoRename(project: string, repo: string, dir: string): Promise<void> {
  const summary = await resolveProject(project)
  const link = projectRepoOf(summary, repo)
  await api.project[':projectId'].repo[':repo'].$patch({ param: { projectId: summary.id, repo: link.id }, json: { dir } })
  console.log(`${link.dir} of project "${summary.name}" is now ${dir}. Existing workspaces keep their checkouts where they are.`)
}

/**
 * Show or set one of a link's two k8s-only settings: `readOnly` (the proxy
 * refuses the project's workspaces any git write to the repo) or `ghToken`
 * (the repo's token may be `GH_TOKEN`). A containerless server refuses
 * both.
 */
async function projectRepoFlag(
  flag: 'readOnly' | 'ghToken',
  project: string,
  repo: string,
  value: 'on' | 'off' | undefined,
): Promise<void> {
  const summary = await resolveProject(project)
  const link = projectRepoOf(summary, repo)
  const name = `${link.dir} of project "${summary.name}"`
  const says = (on: boolean): string => (flag === 'readOnly'
    ? on ? 'is read-only: its workspaces can fetch it but not push to it' : 'can be pushed to by its workspaces'
    : on ? 'lets its token be GH_TOKEN' : 'keeps its token from being GH_TOKEN')
  if (value === undefined) {
    console.log(`${name} ${says(link[flag])}.`
      + (flag === 'ghToken' && link.ghToken && link.readOnly
        ? ' While the repo is read-only its token is never GH_TOKEN, whatever this says.' : ''))
    return
  }
  const route = api.project[':projectId'].repo[':repo'][flag === 'readOnly' ? 'read-only' : 'gh-token']
  await route.$put({ param: { projectId: summary.id, repo: link.id }, json: { enabled: value === 'on' } })
  console.log(`${name} now ${says(value === 'on')}.`)
}

export const projectRepoReadOnly = (project: string, repo: string, value?: 'on' | 'off'): Promise<void> =>
  projectRepoFlag('readOnly', project, repo, value)

export const projectRepoGhToken = (project: string, repo: string, value?: 'on' | 'off'): Promise<void> =>
  projectRepoFlag('ghToken', project, repo, value)
