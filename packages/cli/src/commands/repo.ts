import { api, findUser, projectScope, resolveRepo } from '#commands/api'
import { repoRemote } from '#commands/project-list'
import { printTable } from '#commands/table'
import { confirmDefault } from '@yaac/shared/confirm'
import type { RepoHolder, RepoSummary } from '@yaac/shared/types'

/**
 * `yaac repo …`: a user's git repos, whatever projects link them
 * (docs/project-repos.md): the listing, sharing a repo yaac hosts, and
 * deleting one. A repo is named by its id or unique id prefix, its remote
 * URL, or `<project>/<folder>` (`resolveRepo`).
 */

/** The repos the user in scope owns, then those shared with them. Repos no
 *  project links come first, since nothing else shows them. */
export async function repoList(): Promise<void> {
  const [scope, repos, { users }] = await Promise.all([projectScope(), api.repo.list.$get(), api.whoami.$get()])
  const userName = (id: string): string => {
    const user = users.find((u) => u.id === id)
    return user?.login ?? user?.name ?? id
  }
  const mine = repos.filter((r) => r.owner === scope.userId)
  const shared = repos.filter((r) => r.owner !== scope.userId && r.sharedWith.includes(scope.userId) && r.deleted === undefined)
  if (mine.length + shared.length === 0) {
    console.log('No repos. Adding a project with `yaac project add` or `yaac project create` makes one.')
    return
  }
  const rank = (r: RepoSummary): number => (r.deleted !== undefined ? 2 : r.projects.length === 0 ? 0 : 1)
  printTable(
    [
      { header: 'REPO' }, { header: 'REMOTE' }, { header: 'CREDENTIAL' }, { header: 'PROJECTS' },
      { header: 'SHARED', optional: true }, { header: 'NOTE', optional: true },
    ],
    [...[...mine].sort((a, b) => rank(a) - rank(b)), ...shared].map((r) => [
      r.id.slice(0, 8),
      repoRemote(r),
      r.hosted ? '(none needed)' : r.gitCredential?.name ?? '(none)',
      r.projects.length === 0 ? '(not linked)' : r.projects.map((p) => p.name).join(', '),
      r.owner !== scope.userId ? `by ${userName(r.owner)}`
        : r.sharedWith.length > 0 ? `with ${r.sharedWith.map(userName).join(', ')}` : '',
      r.deleted !== undefined ? `deleted; held by ${r.deleted.heldBy.length} workspace(s)` : '',
    ]),
  )
}

/** Share a repo yaac hosts with another user, who can then link it into
 *  their own projects. */
export async function repoShare(repo: string, user: string): Promise<void> {
  const [target, { users }] = await Promise.all([resolveRepo(repo), api.whoami.$get()])
  const userId = findUser(users, user)
  await api.repo[':repoId'].share.$post({ param: { repoId: target.id }, json: { userId } })
  console.log(`Repo ${target.id.slice(0, 8)} is now shared with ${user}, who can link it with `
    + `\`yaac project repo add <project> --repo-id ${target.id}\`.`)
}

/** End a user's share of a repo, stopping their running workspaces that
 *  hold a checkout of it. */
export async function repoUnshare(repo: string, user: string): Promise<void> {
  const [target, { users }] = await Promise.all([resolveRepo(repo), api.whoami.$get()])
  const userId = findUser(users, user)
  await api.repo[':repoId'].unshare.$post({ param: { repoId: target.id }, json: { userId } })
  console.log(`Repo ${target.id.slice(0, 8)} is no longer shared with ${user}. Their running workspaces holding a `
    + 'checkout of it were stopped; their projects still link it, and work again if it is shared again.')
}

/** Which workspaces hold a checkout of a deleted repo, by project. */
function printHolders(heldBy: RepoHolder[], userName: (id: string) => string): void {
  for (const h of heldBy) {
    console.log(`  ${h.workspaceId}  in ${h.projectName} (${userName(h.owner)})`)
  }
}

/**
 * Delete a repo: unlink it from every project, end its shares, and for a
 * repo yaac hosts delete the repository itself, the only copy of its code.
 * It says what it reaches and asks first, defaulting to no. No workspace
 * is deleted, and while any holds a checkout the main clone stays, so the
 * workspaces still holding it are listed with how to remove it for good.
 */
export async function repoDelete(repo: string, opts: { yes?: boolean }): Promise<void> {
  const [target, { users }] = await Promise.all([resolveRepo(repo), api.whoami.$get()])
  const userName = (id: string): string => {
    const user = users.find((u) => u.id === id)
    return user?.login ?? user?.name ?? id
  }
  const name = target.hosted ? `repo ${target.id.slice(0, 8)} (hosted by yaac)` : target.remoteUrl
  const param = { repoId: target.id }
  const preview = await api.repo[':repoId']['delete-preview'].$get({ param })
  // A script reading the exit code must not take a delete that never ran
  // for success.
  if (!opts.yes && !process.stdin.isTTY) {
    console.error('No terminal to confirm on; pass --yes to delete without asking.')
    process.exitCode = 1
    return
  }
  if (!opts.yes && !await confirmDefault(
    `This deletes ${name}: it is unlinked from ${preview.projects.length} project(s), other users' included, `
    + `and ${preview.heldBy.length} workspace(s) holding a checkout of it keep their files but lose their remote.`
    + (target.sharedWith.length > 0 ? ` Its sharing with ${target.sharedWith.map(userName).join(', ')} ends.` : '')
    + (preview.hosted ? ' yaac hosts this repository, so this deletes the only copy of its code outside those checkouts.' : '')
    + ' Continue?',
  )) {
    console.log('Aborted — nothing was deleted.')
    return
  }
  const { heldBy } = await api.repo[':repoId'].$delete({ param })
  if (heldBy.length === 0) {
    console.log(`Deleted ${name}, with its main clone.`)
    return
  }
  console.log(`Deleted ${name}. These workspaces still hold a checkout of it, which borrows the objects of its `
    + 'main clone, so the clone stays on the server:')
  printHolders(heldBy, userName)
  console.log('Delete them (`yaac workspace delete <id>`) and the server removes the repo\'s objects for good.')
}
