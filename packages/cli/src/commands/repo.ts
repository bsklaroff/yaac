import { api, findUser, projectScope, resolveGitCredentialId, resolveRepo } from '#commands/api'
import { repoRemote } from '#commands/project-list'
import { printTable } from '#commands/table'
import { confirmDefault } from '@yaac/shared/confirm'
import type { RepoHolder, RepoSummary } from '@yaac/shared/types'

/**
 * `yaac repo …`: a user's git repos, whatever projects link them
 * (docs/project-repos.md): the listing, sharing a repo yaac hosts, its
 * read-only and upstream settings (docs/repo-forks.md), and deleting one. A repo is named by its id or unique id prefix, its remote
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
      [
        ...(r.deleted !== undefined ? [`deleted; held by ${r.deleted.heldBy.length} workspace(s)`] : []),
        ...repoNotes(r, repos),
      ].join('; '),
    ]),
  )
}

/** What `repo list` notes about a repo's fork settings (docs/repo-forks.md). */
function repoNotes(r: RepoSummary, repos: RepoSummary[]): string[] {
  const remote = (id: string): string => {
    const other = repos.find((o) => o.id === id)
    return other === undefined ? id.slice(0, 8) : repoRemote(other)
  }
  return [
    ...(r.readOnly ? ['read-only'] : []),
    ...(r.pushRefused === true ? ['pushes refused'] : []),
    ...(r.upstreamRepoId !== undefined ? [`fork of ${remote(r.upstreamRepoId)}`] : []),
    ...(r.forks.length > 0 ? [`upstream of ${r.forks.map(remote).join(', ')}`] : []),
    ...(r.upstreamFetchError !== undefined ? [`upstream fetch failed: ${r.upstreamFetchError}`] : []),
  ]
}

/** Make a repo read-only, so no workspace pushes to it, or writable again;
 *  with no value, say which it is. */
export async function repoReadOnly(repo: string, value: 'on' | 'off' | undefined): Promise<void> {
  const target = await resolveRepo(repo)
  const name = repoRemote(target)
  const says = (on: boolean): string => (on ? 'is read-only: workspaces fetch it and never push' : 'can be pushed to by workspaces')
  if (value === undefined) {
    console.log(`${name} ${says(target.readOnly)}.`)
    return
  }
  await api.repo[':repoId']['read-only'].$put({ param: { repoId: target.id }, json: { enabled: value === 'on' } })
  console.log(`${name} now ${says(value === 'on')}. Running workspaces follow from their next start.`)
}

/** An upstream as the CLI names it: one of your repos (see `resolveRepo`),
 *  else a remote URL read with the named credential, or anonymously. */
export async function upstreamTarget(
  ref: string,
  credential?: string,
): Promise<{ repoId: string } | { remoteUrl: string; credentialId?: string }> {
  if (credential === undefined) {
    const repo = await resolveRepo(ref).catch(() => undefined)
    if (repo !== undefined) return { repoId: repo.id }
  }
  return { remoteUrl: ref, ...(credential !== undefined ? { credentialId: await resolveGitCredentialId(credential) } : {}) }
}

/**
 * Set the repo a fork's history comes from (docs/repo-forks.md), or with
 * `--none` remove it; with neither, say what it is.
 */
export async function repoUpstream(
  repo: string,
  upstream: string | undefined,
  credential: string | undefined,
  opts: { none?: boolean },
): Promise<void> {
  const target = await resolveRepo(repo)
  const name = repoRemote(target)
  const param = { repoId: target.id }
  if (opts.none === true) {
    if (upstream !== undefined) throw new Error('Give an <upstream> or --none, not both.')
    await api.repo[':repoId'].upstream.$delete({ param })
    console.log(`${name} has no upstream now; its upstream/* refs are gone.`)
    return
  }
  if (upstream === undefined) {
    const repos = await api.repo.list.$get()
    const up = repos.find((r) => r.id === target.upstreamRepoId)
    console.log(up === undefined ? `${name} has no upstream.` : `${name} is a fork of ${repoRemote(up)} (repo ${up.id.slice(0, 8)}).`)
    return
  }
  const result = await api.repo[':repoId'].upstream.$put({ param, json: await upstreamTarget(upstream, credential) })
  console.log(`${name} is now a fork of ${upstream} (repo ${result.upstreamRepoId?.slice(0, 8) ?? ''}). Its workspaces `
    + 'see that history as upstream/* within minutes; "sync with upstream" in one of them catches the fork up.')
  if (result.knownHostsEntry !== null) console.log(`Host key trusted: ${result.knownHostsEntry}`)
  if (result.allowedHost !== null) console.log(`Added ${result.allowedHost} to the egress allowlist of the projects linking it.`)
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
