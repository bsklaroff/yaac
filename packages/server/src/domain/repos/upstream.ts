import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { findOwnerRepo, getRepo, insertRepo, listRepos, setRepoGitCredential, updateRepoSettings, type RepoRow } from '#db'
import { probePushAccess, setUpstreamRefs } from '#domain/git'
import type { Actor } from '#domain/access'
import { serverLog } from '#lib/log'
import { env } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { repoDir } from '@yaac/shared/project-paths'
import { canUseRepo, ownRepo } from './access'
import { resolveCredentialForRemote, resolveRepoCredential, validateGitRemoteUrl } from './credentials'
import { fetchRepoOrigin } from './origin'

/*
 * A repo's upstream (docs/repo-forks.md): another of its owner's repos,
 * whose history is fetched into the fork's main clone as `upstream/*` and
 * reaches its checkouts as a remote that can only be fetched.
 */

/** What a repo's upstream is set to: one of its owner's repos, or a
 *  remote, read with one of their credentials or anonymously. */
export type UpstreamTarget = { repoId: string } | { remoteUrl: string; credentialId?: string }

/**
 * `owner`'s repo for `remoteUrl`, recorded without a clone if they have
 * none: a repo is cloned when a project links it. A new one is read-only
 * when its credential cannot push there, or it has none, which only an
 * https remote, read anonymously, may. An existing one without a credential
 * takes the one given.
 */
export async function recordRemoteRepo(
  owner: string,
  remoteUrl: string,
  credentialId?: string,
): Promise<{ repo: RepoRow; knownHostsEntry: string | null }> {
  const { scheme } = validateGitRemoteUrl(remoteUrl)
  const resolved = credentialId !== undefined ? await resolveCredentialForRemote(owner, credentialId, remoteUrl) : undefined
  if (resolved === undefined && scheme !== 'https') {
    throw new ServerError('VALIDATION', `${remoteUrl} is an SSH remote, which cannot be read without a credential.`)
  }
  const knownHostsEntry = resolved?.knownHostsEntry ?? null
  const existing = await findOwnerRepo(owner, remoteUrl)
  if (existing) {
    if (credentialId === undefined || existing.gitCredentialId !== null) return { repo: existing, knownHostsEntry: existing.knownHostsEntry }
    await setRepoGitCredential(existing.id, credentialId, knownHostsEntry)
    return { repo: { ...existing, gitCredentialId: credentialId, knownHostsEntry }, knownHostsEntry }
  }
  const pushAccess = resolved ? await probePushAccess(remoteUrl, resolved.credential) : null
  const repo = await insertRepo(
    { id: crypto.randomUUID(), owner, remoteUrl, pushAccess, readOnly: resolved === undefined || pushAccess === 'no' },
    credentialId !== undefined ? { id: credentialId, knownHostsEntry } : undefined,
  )
  return { repo, knownHostsEntry }
}

/** A repo's upstream, when `userId` may use it: a fork's upstream is its
 *  owner's, so another user a hosted fork is shared with gets none. */
export async function usableUpstream(repo: RepoRow, userId: string): Promise<RepoRow | undefined> {
  if (repo.upstreamRepoId === null) return undefined
  const upstream = await getRepo(repo.upstreamRepoId)
  return upstream && upstream.owner === userId && await canUseRepo(userId, upstream) ? upstream : undefined
}

/**
 * Set a repo's upstream, or with `null` remove it, which deletes
 * `upstream/*` from its main clone. Only its owner may, and only to a repo
 * they may use (`canUseRepo`) that is neither the repo itself nor one whose
 * chain of upstreams leads back to it. With a main clone, the fork fetches
 * its origin and then the new upstream in the background. Answers the
 * upstream, with the host key trusted for a fresh ssh credential.
 */
export async function setRepoUpstream(
  principal: Actor,
  repoId: string,
  target: UpstreamTarget | null,
): Promise<{ upstream: RepoRow | null; knownHostsEntry: string | null }> {
  const repo = await ownRepo(principal, repoId)
  if (repo.deletedAt !== undefined) throw new ServerError('VALIDATION', `${repo.remoteUrl} was deleted`)
  const cloned = await fs.access(repoDir(repoId)).then(() => true, () => false)
  if (target === null) {
    if (repo.upstreamRepoId === null) return { upstream: null, knownHostsEntry: null }
    await updateRepoSettings(repoId, { upstreamRepoId: null })
    if (cloned) await setUpstreamRefs(repoDir(repoId), { drop: true })
    return { upstream: null, knownHostsEntry: null }
  }
  let upstream: RepoRow
  let knownHostsEntry: string | null = null
  if ('repoId' in target) {
    const found = await getRepo(target.repoId)
    if (!found || !await canUseRepo(repo.owner, found)) throw new ServerError('NOT_FOUND', `repo ${target.repoId} not found`)
    upstream = found
  } else {
    ({ repo: upstream, knownHostsEntry } = await recordRemoteRepo(repo.owner, target.remoteUrl, target.credentialId))
  }
  const repos = new Map((await listRepos()).map((r) => [r.id, r]))
  for (let at: RepoRow | undefined = upstream; at !== undefined; at = repos.get(at.upstreamRepoId ?? '')) {
    if (at.id === repoId) {
      throw new ServerError('VALIDATION', at === upstream
        ? 'a repo cannot be its own upstream'
        : `${upstream.remoteUrl} is already a fork of ${repo.remoteUrl}, so it cannot be its upstream`)
    }
  }
  if (repo.upstreamRepoId !== upstream.id) {
    if (cloned && repo.upstreamRepoId !== null) await setUpstreamRefs(repoDir(repoId), { drop: true })
    await updateRepoSettings(repoId, { upstreamRepoId: upstream.id })
  }
  if (cloned) {
    fetchRepoOrigin(repoId).catch((err: unknown) => serverLog(`[git] fetching ${repoId}: ${String(err)}`))
  }
  return { upstream, knownHostsEntry }
}

/**
 * For a repo on github.com read with an https token, the clone URL of the
 * repo it is a fork of there, which clients offer as its upstream
 * (docs/repo-forks.md "Remote forks"). Undefined when it is no fork, has an
 * upstream already, or GitHub does not answer, and never with Tor on:
 * only a suggestion.
 */
export async function suggestUpstream(repo: RepoRow): Promise<string | undefined> {
  // A lookup outside git would bypass the Tor route git takes.
  if (repo.upstreamRepoId !== null || repo.hosted || env.useTor) return undefined
  const { host, path } = validateGitRemoteUrl(repo.remoteUrl)
  const credential = host === 'github.com' ? await resolveRepoCredential(repo) : null
  if (credential?.kind !== 'https') return undefined
  try {
    const res = await fetch(`https://api.github.com/repos/${path}`, {
      headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'yaac' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return undefined
    const { parent } = await res.json() as { parent?: { clone_url?: unknown } }
    return typeof parent?.clone_url === 'string' ? parent.clone_url : undefined
  } catch {
    return undefined
  }
}
