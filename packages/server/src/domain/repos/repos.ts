import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDataDir, hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import {
  cloneRepo, fillHostedRepo, getDefaultBranch, initHostedRepo, isGitAuthError, probePushAccess, setUpstreamRefs,
  type ResolvedGitCredential,
} from '#domain/git'
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
  updateRepoSettings,
  type RepoRow,
} from '#db'
import type { Actor } from '#domain/access'
import { ServerError } from '@yaac/shared/errors'
import type { GitProgress, RepoSummary } from '@yaac/shared/types'
import { createKeyedMutex } from '#lib/keyed-mutex'
import {
  probeRepoPushAccess, repoCredentialNames, resolveCredentialForRemote, resolveRepoCredential, validateGitRemoteUrl,
} from './credentials'
import { upstreamFetchError } from './origin'
import { ownRepo } from './access'

/*
 * A user's repos: adding one by URL, creating one the server hosts, sharing
 * a hosted one, and the listing (docs/project-repos.md).
 */

/** Serializes `addRepo` per owner and remote, and a repo's first clone. */
const perRemote = createKeyedMutex()

/** How `addRepo` takes a remote (docs/repo-forks.md). */
export interface AddRepoOptions {
  /** The credential to clone with and assign. Without one the remote is
   *  read anonymously, which only `readOnly` or `fork` allows. */
  credentialId?: string
  /** No workspace pushes to it. */
  readOnly?: boolean
  /** Answer a repo yaac hosts whose upstream is the remote. */
  fork?: boolean
}

/**
 * The repo `owner` reaches `remoteUrl` through, cloning it if they have
 * none yet, with git's progress reported to `onProgress`. One they already
 * have is answered as it is, taking the credential only if it has none, so
 * two projects of one user on one remote share a main clone, a credential
 * and every fetch. Two calls for one owner and remote run one at a time, so
 * the second finds the repo the first cloned rather than cloning it again.
 *
 * A new remote's push access is probed before the clone, and one the
 * credential cannot push to is refused (`PUSH_REFUSED`) unless it is added
 * read-only or as a fork (docs/repo-forks.md "Push access"). A fork is a
 * repo yaac hosts, filled from the clone, whose upstream is the remote's
 * repo. User-facing failures throw `ServerError`.
 */
export async function addRepo(
  owner: string,
  remoteUrl: string,
  opts: AddRepoOptions,
  onProgress?: (progress: GitProgress) => void,
): Promise<{ repo: RepoRow; knownHostsEntry: string | null }> {
  const parsed = validateGitRemoteUrl(remoteUrl)
  await ensureDataDir()
  const resolved = opts.credentialId !== undefined
    ? await resolveCredentialForRemote(owner, opts.credentialId, remoteUrl)
    : undefined
  const readOnly = opts.readOnly === true
  const fork = opts.fork === true
  if (resolved === undefined && !readOnly && !fork) {
    throw new ServerError('VALIDATION', 'Nobody can push to a remote without a git credential: '
      + 'name one, or add the remote read-only or as a fork.')
  }
  if (resolved === undefined && parsed.scheme !== 'https') {
    throw new ServerError('VALIDATION', `${remoteUrl} is an SSH remote, which cannot be read without a credential.`)
  }
  const knownHostsEntry = resolved?.knownHostsEntry ?? null
  const assigned = opts.credentialId !== undefined ? { id: opts.credentialId, knownHostsEntry } : undefined
  return perRemote(`${owner} ${remoteUrl}`, async () => {
    const existing = await findOwnerRepo(owner, remoteUrl)
    if (existing) {
      const repo = await reuseRepo(existing, { readOnly, fork }, assigned)
      return { repo: fork ? await forkRepo(repo, onProgress) : repo, knownHostsEntry: repo.knownHostsEntry }
    }
    const pushAccess = resolved ? await probePushAccess(remoteUrl, resolved.credential) : null
    if (pushAccess === 'no' && !readOnly && !fork) {
      throw new ServerError('PUSH_REFUSED', `You can't push to ${parsed.host}/${parsed.path} with "${resolved?.name}".\n`
        + '  --fork       yaac hosts a fork of it that workspaces push to\n'
        + '  --read-only  workspaces only read it')
    }
    const id = crypto.randomUUID()
    await cloneMain(id, remoteUrl, resolved?.credential ?? null, onProgress)
    // A fork's upstream is read-only where nothing could push to it.
    const fields = { owner, remoteUrl, pushAccess, readOnly: readOnly || (fork && (resolved === undefined || pushAccess === 'no')) }
    if (!fork) return { repo: await insertRepo({ id, ...fields }, assigned), knownHostsEntry }
    const upstream = await insertRepo({ id: crypto.randomUUID(), ...fields }, assigned)
    return { repo: await hostClone(id, owner, upstream.id), knownHostsEntry }
  })
}

/**
 * An owner's existing repo for a remote they add again: it takes the
 * credential if it has none, becomes read-only when asked, and is cloned
 * if it has never been, which is refused for the upstream of a fork unless
 * another fork is wanted: the fork already holds its history.
 */
async function reuseRepo(
  existing: RepoRow,
  opts: { readOnly: boolean; fork: boolean },
  credential: { id: string; knownHostsEntry: string | null } | undefined,
): Promise<RepoRow> {
  const forks = (await listRepos()).filter((r) => r.upstreamRepoId === existing.id && r.deletedAt === undefined)
  if (!opts.fork && forks.length > 0 && !await hasMainClone(existing.id)) {
    throw new ServerError('CONFLICT', `You already have ${existing.remoteUrl} as the upstream of `
      + `${forks.map((f) => `repo ${f.id.slice(0, 8)}`).join(', ')}. Link that fork instead `
      + `(by its id, ${forks[0].id}), or link ${existing.remoteUrl} itself by its id (${existing.id}), `
      + 'which clones it a second time.')
  }
  if (credential !== undefined && existing.gitCredentialId === null) {
    await setRepoGitCredential(existing.id, credential.id, credential.knownHostsEntry)
  }
  if (opts.readOnly && !existing.readOnly) await updateRepoSettings(existing.id, { readOnly: true })
  const repo = (await getRepo(existing.id)) ?? existing
  if (!opts.fork) await ensureMainClone(repo)
  return repo
}

/** Whether a repo has its main clone: one that is only an upstream has
 *  none until a project links it. */
async function hasMainClone(repoId: string): Promise<boolean> {
  return fs.access(repoDir(repoId)).then(() => true, () => false)
}

/**
 * Clone a repo that has no main clone yet, as linking one that was only an
 * upstream does (docs/repo-forks.md "The model"). A no-op for one that has
 * its clone.
 */
export async function ensureMainClone(repo: RepoRow, onProgress?: (progress: GitProgress) => void): Promise<void> {
  await perRemote(`clone ${repo.id}`, async () => {
    if (await hasMainClone(repo.id)) return
    await cloneMain(repo.id, repo.hosted ? hostedRepoDir(repo.id) : repo.remoteUrl, await resolveRepoCredential(repo), onProgress)
  })
}

/** Clone `remoteUrl` as repo `id`'s main clone, leaving nothing behind on
 *  failure, which is told as a `ServerError`. */
async function cloneMain(
  id: string,
  remoteUrl: string,
  credential: ResolvedGitCredential | null,
  onProgress?: (progress: GitProgress) => void,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(repoDir(id)), { recursive: true })
    await cloneRepo(remoteUrl, repoDir(id), credential, onProgress)
  } catch (err) {
    await fs.rm(repoDir(id), { recursive: true, force: true })
    // Git's "Cloning into '<path>'..." names a server path, which the
    // error shown to clients has no use for.
    const message = (err instanceof Error ? err.message : String(err)).replace(/^Cloning into .*\n?/m, '')
    if (isGitAuthError(message)) {
      let host = remoteUrl
      try {
        host = validateGitRemoteUrl(remoteUrl).host
      } catch { /* a hosted repo's path names itself */ }
      throw new ServerError(
        'VALIDATION',
        `git authentication failed for ${host} — the credential was rejected `
        + '(a revoked token, or a key not yet registered with the host?).',
      )
    }
    throw new ServerError('INTERNAL', `Failed to clone: ${message}`)
  }
}

/**
 * Another fork of a repo its owner already has: a copy of its main clone
 * (or a fresh clone of its remote) becomes a hosted repo whose upstream it
 * is. Several forks may name one upstream.
 */
async function forkRepo(upstream: RepoRow, onProgress?: (progress: GitProgress) => void): Promise<RepoRow> {
  if (upstream.hosted) throw new ServerError('VALIDATION', `${upstream.remoteUrl} is hosted by yaac already.`)
  const id = crypto.randomUUID()
  if (await hasMainClone(upstream.id)) {
    await fs.mkdir(path.dirname(repoDir(id)), { recursive: true })
    await fs.cp(repoDir(upstream.id), repoDir(id), { recursive: true })
  } else {
    await cloneMain(id, upstream.remoteUrl, await resolveRepoCredential(upstream), onProgress)
  }
  return hostClone(id, upstream.owner, upstream.id)
}

/**
 * Make repo `id`'s fresh main clone a hosted fork of `upstreamId`
 * (docs/repo-forks.md "Moving a repo to yaac", steps 2 to 4, with no
 * workspaces to stop): a bare repository filled with its branches and
 * tags, its `origin/*` copied to `upstream/*`, and the row. A failure
 * leaves neither directory behind.
 */
async function hostClone(id: string, owner: string, upstreamId: string): Promise<RepoRow> {
  try {
    await fs.mkdir(path.dirname(hostedRepoDir(id)), { recursive: true })
    await initHostedRepo(hostedRepoDir(id))
    await fillHostedRepo(hostedRepoDir(id), repoDir(id), await getDefaultBranch(repoDir(id)))
    await setUpstreamRefs(repoDir(id))
    return await insertRepo({ id, owner, remoteUrl: hostedRemoteUrl(id), hosted: true, upstreamRepoId: upstreamId })
  } catch (err) {
    await fs.rm(hostedRepoDir(id), { recursive: true, force: true })
    await fs.rm(repoDir(id), { recursive: true, force: true })
    if (err instanceof ServerError) throw err
    throw new ServerError('INTERNAL', `Failed to make the fork: ${err instanceof Error ? err.message : String(err)}`)
  }
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

/**
 * Make a repo read-only, so no workspace pushes to it in any project, or
 * writable again, which probes its push access (docs/repo-forks.md
 * "Read-only repos"). Only its owner may.
 */
export async function setRepoReadOnly(principal: Actor, repoId: string, enabled: boolean): Promise<void> {
  const repo = await ownRepo(principal, repoId)
  if (repo.deletedAt !== undefined) throw new ServerError('VALIDATION', `${repo.remoteUrl} was deleted`)
  await updateRepoSettings(repoId, { readOnly: enabled })
  if (!enabled) await probeRepoPushAccess([repoId])
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
    readOnly: repo.readOnly,
    ...(repo.pushAccess === 'no' && !repo.readOnly && !repo.hosted ? { pushRefused: true as const } : {}),
    ...(repo.upstreamRepoId !== null ? { upstreamRepoId: repo.upstreamRepoId } : {}),
    forks: rows.filter((r) => r.upstreamRepoId === repo.id && r.deletedAt === undefined).map((r) => r.id),
    guardAllowsCatchUp: repo.guardAllowsCatchUp,
    ...(upstreamFetchError(repo.id) !== undefined ? { upstreamFetchError: upstreamFetchError(repo.id) } : {}),
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
