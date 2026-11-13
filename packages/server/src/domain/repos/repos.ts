import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDataDir, hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import { cloneRepo, initHostedRepo, isGitAuthError } from '#domain/git'
import {
  addRepoShare,
  findOwnerRepo,
  getRepo,
  insertRepo,
  listAllProjectRepos,
  listProjectRows,
  listRepoHolders,
  listRepos,
  listRepoShares,
  listUsers,
  setRepoGitCredential,
  type RepoRow,
} from '#db'
import type { Actor } from '#domain/access'
import { ServerError } from '@yaac/shared/errors'
import type { GitProgress, RepoSummary } from '@yaac/shared/types'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { repoCredentialNames, resolveCredentialForRemote, validateGitRemoteUrl } from './credentials'
import { ownRepo } from './access'

/*
 * A user's repos: adding one by URL, creating one the server hosts, sharing
 * a hosted one, and the listing (docs/project-repos.md).
 */

/** Serializes `addRepo` per owner and remote. */
const perRemote = createKeyedMutex()

/**
 * The repo `owner` reaches `remoteUrl` through, cloning it with the named
 * credential if they have none yet (docs/git-credentials.md), with git's
 * progress reported to `onProgress`. One they already have is answered as
 * it is, taking the credential only if it has none, so two projects of one
 * user on one remote share a main clone, a credential and every fetch. Two
 * calls for one owner and remote run one at a time, so the second finds the
 * repo the first cloned rather than cloning it again. User-facing failures
 * throw `ServerError`.
 */
export async function addRepo(
  owner: string,
  remoteUrl: string,
  gitCredentialId: string,
  onProgress?: (progress: GitProgress) => void,
): Promise<{ repo: RepoRow; knownHostsEntry: string | null }> {
  const parsed = validateGitRemoteUrl(remoteUrl)
  await ensureDataDir()
  const { credential, knownHostsEntry } = await resolveCredentialForRemote(owner, gitCredentialId, remoteUrl)
  return perRemote(`${owner} ${remoteUrl}`, async () => {
    const existing = await findOwnerRepo(owner, remoteUrl)
    if (existing) {
      if (existing.gitCredentialId !== null) return { repo: existing, knownHostsEntry: existing.knownHostsEntry }
      await setRepoGitCredential(existing.id, gitCredentialId, knownHostsEntry)
      return { repo: { ...existing, gitCredentialId, knownHostsEntry }, knownHostsEntry }
    }
    const id = crypto.randomUUID()
    try {
      await fs.mkdir(path.dirname(repoDir(id)), { recursive: true })
      await cloneRepo(remoteUrl, repoDir(id), credential, onProgress)
    } catch (err) {
      await fs.rm(repoDir(id), { recursive: true, force: true })
      // Git's "Cloning into '<path>'..." names a server path, which the
      // error shown to clients has no use for.
      const message = (err instanceof Error ? err.message : String(err)).replace(/^Cloning into .*\n?/m, '')
      if (isGitAuthError(message)) {
        throw new ServerError(
          'VALIDATION',
          `git authentication failed for ${parsed.host} — the credential was rejected `
          + '(a revoked token, or a key not yet registered with the host?).',
        )
      }
      throw new ServerError('INTERNAL', `Failed to clone: ${message}`)
    }
    return { repo: await insertRepo({ id, owner, remoteUrl }, { id: gitCredentialId, knownHostsEntry }), knownHostsEntry }
  })
}

/**
 * Create an empty repo whose remote the server hosts
 * (docs/hosted-projects.md). Its main clone is cloned from the hosted bare
 * repository like any other remote, so everything downstream runs as for a
 * cloned repo. A failure leaves nothing behind.
 */
export async function createHostedRepo(owner: string): Promise<RepoRow> {
  await ensureDataDir()
  const id = crypto.randomUUID()
  const hosted = hostedRepoDir(id)
  try {
    await fs.mkdir(path.dirname(hosted), { recursive: true })
    await fs.mkdir(path.dirname(repoDir(id)), { recursive: true })
    await initHostedRepo(hosted)
    await cloneRepo(hosted, repoDir(id), { kind: 'hosted' })
    return await insertRepo({ id, owner, remoteUrl: hostedRemoteUrl(id), hosted: true })
  } catch (err) {
    await fs.rm(hosted, { recursive: true, force: true })
    await fs.rm(repoDir(id), { recursive: true, force: true })
    if (err instanceof ServerError) throw err
    throw new ServerError('INTERNAL', `Failed to create the repository: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Record a repo whose main clone is already staged in the data dir under
 * `id`, without cloning; test suites use this for local repos. Refuses a
 * remote `addRepo` would reject, a missing staged clone, and an id already
 * recorded.
 */
export async function registerStagedRepo(id: string, remoteUrl: string, owner: string): Promise<RepoRow> {
  // The remote decides every later fetch's transport, so validate it as
  // `addRepo` does.
  validateGitRemoteUrl(remoteUrl)
  try {
    await fs.access(repoDir(id))
  } catch {
    throw new ServerError('NOT_FOUND', `no main clone is staged for repo ${id}`)
  }
  if (await getRepo(id)) throw new ServerError('CONFLICT', `Repo ${id} already exists`)
  return insertRepo({ id, owner, remoteUrl })
}

/**
 * Share a hosted repo with another user (docs/hosted-projects.md
 * "Sharing"), who may then link it into their own projects. Only the owner
 * shares, and only a repo yaac hosts: one hosted elsewhere is reached with
 * a credential, which each user brings.
 */
export async function shareRepo(principal: Actor, repoId: string, userId: string): Promise<void> {
  const repo = await ownRepo(principal, repoId)
  if (!repo.hosted || repo.deletedAt !== undefined) {
    throw new ServerError('VALIDATION', `${repo.remoteUrl} can't be shared: only a repo hosted by yaac can be.`)
  }
  if (userId === repo.owner) throw new ServerError('VALIDATION', 'the repo is already yours')
  if (!(await listUsers()).some((u) => u.id === userId)) throw new ServerError('NOT_FOUND', `user ${userId} not found`)
  await addRepoShare(repoId, userId)
}

/** Every repo, each with its credential, the projects that link it, whom
 *  it is shared with and, once deleted, the workspaces still holding it. */
export async function listRepoSummaries(): Promise<RepoSummary[]> {
  const [rows, links, shares, projects] = await Promise.all([
    listRepos(), listAllProjectRepos(), listRepoShares(), listProjectRows(),
  ])
  const credentials = await repoCredentialNames(rows)
  const projectOf = new Map(projects.map((p) => [p.id, p]))
  return Promise.all(rows.map(async (repo): Promise<RepoSummary> => ({
    id: repo.id,
    owner: repo.owner,
    remoteUrl: repo.remoteUrl,
    hosted: repo.hosted,
    guardDefaultBranch: repo.guardDefaultBranch,
    ...(repo.keepsHostedRepo ? { keepsHostedRepo: true } : {}),
    gitCredential: credentials.get(repo.id) ?? null,
    projects: projects
      .filter((p) => links.get(p.id)?.some((l) => l.repo.id === repo.id) === true)
      .map((p) => ({ id: p.id, name: p.name, owner: p.owner })),
    sharedWith: shares.filter((s) => s.repoId === repo.id).map((s) => s.userId),
    ...(repo.deletedAt !== undefined
      ? {
        deleted: {
          heldBy: (await listRepoHolders(repo.id)).flatMap((h) => {
            const project = projectOf.get(h.projectId)
            return project
              ? [{ workspaceId: h.workspaceId, projectId: h.projectId, projectName: project.name, owner: project.owner }]
              : []
          }),
        },
      }
      : {}),
  })))
}
