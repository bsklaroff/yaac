import { ServerError } from '@yaac/shared/errors'
import { parseGitRemote, usableAssignment } from '@yaac/shared/git-remote'
import {
  deleteGitCredential,
  getGitCredential,
  insertGitCredential,
  listGitCredentials,
  listProjectRows,
  listRepos,
  renameGitCredential,
  replaceGitCredential,
  type GitCredentialRow,
  type RepoRow,
} from '#db'
import { encodeOpenSshPrivateKey, generateSshKey, withKeyComment } from '#lib/ssh-key'
import type { GitCredentialSummary } from '@yaac/shared/types'
import type { HttpsCredentialEntry, RepoGrant, SshCredentialEntry } from '#drivers/contract'

/**
 * A user's git credentials (docs/git-credentials.md): HTTPS tokens and
 * generated SSH keys, stored under a name and assigned to repos by
 * `#domain/repos`.
 */

const MAX_NAME_LENGTH = 100

function validName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new ServerError('VALIDATION', 'A git credential needs a name.')
  if (name.length > MAX_NAME_LENGTH || /[\r\n]/.test(name)) {
    throw new ServerError('VALIDATION', `A git credential name is one line of at most ${MAX_NAME_LENGTH} characters.`)
  }
  return name
}

/** Store an HTTPS token under a name, owned by `owner`. */
export async function addHttpsCredential(
  owner: string,
  params: { name: string; token: string },
): Promise<{ id: string }> {
  const token = params.token.trim()
  if (!token) throw new ServerError('VALIDATION', 'Token cannot be empty.')
  const row = await insertGitCredential({ owner, name: validName(params.name), kind: 'https', secret: token })
  return { id: row.id }
}

/**
 * Generate and store an SSH key under a name. Returns the public key for the
 * user to register with their git host. No host is contacted until the key
 * is assigned to a repo.
 */
export async function generateSshCredential(
  owner: string,
  params: { name: string },
): Promise<{ id: string; publicKey: string }> {
  const name = validName(params.name)
  const key = generateSshKey(name)
  const row = await insertGitCredential({
    owner, name, kind: 'ssh', secret: key.seed.toString('base64'), publicKey: key.publicKey,
  })
  return { id: row.id, publicKey: key.publicKey }
}

/** One of `owner`'s credentials; another user's reads as missing. */
async function ownCredential(owner: string, id: string): Promise<GitCredentialRow> {
  const cred = await getGitCredential(id)
  if (cred?.owner !== owner) throw new ServerError('NOT_FOUND', 'No such git credential.')
  return cred
}

/**
 * Rename one of `owner`'s credentials. For a key this also changes the
 * public key's comment, which doesn't affect authentication, so copies
 * registered with a host keep working.
 */
export async function renameCredential(owner: string, id: string, rawName: string): Promise<void> {
  const name = validName(rawName)
  const cred = await ownCredential(owner, id)
  const publicKey = cred.publicKey === null ? null : withKeyComment(cred.publicKey, name)
  await renameGitCredential(id, name, publicKey)
}

/**
 * Replace the secret of one of `owner`'s credentials (a pasted token, or a
 * newly generated key), keeping its name and repo assignments. For a
 * key, returns the new public key, which the user must register with the
 * git host.
 */
export async function replaceCredential(
  owner: string,
  id: string,
  params: { token?: string },
): Promise<{ id: string; publicKey?: string }> {
  const cred = await ownCredential(owner, id)
  if (cred.kind === 'https') {
    const token = params.token?.trim()
    if (!token) throw new ServerError('VALIDATION', 'Token cannot be empty.')
    const row = await replaceGitCredential(id, { secret: token })
    if (!row) throw new ServerError('NOT_FOUND', 'No such git credential.')
    return { id: row.id }
  }
  const key = generateSshKey(cred.name)
  const row = await replaceGitCredential(id, { secret: key.seed.toString('base64'), publicKey: key.publicKey })
  if (!row) throw new ServerError('NOT_FOUND', 'No such git credential.')
  return { id: row.id, publicKey: key.publicKey }
}

/** Delete one of `owner`'s credentials; the repos that used it are left
 *  with none. */
export async function removeCredential(owner: string, id: string): Promise<void> {
  await ownCredential(owner, id)
  if (!await deleteGitCredential(id)) throw new ServerError('NOT_FOUND', 'No such git credential.')
}

/**
 * Every credential of `owner`'s with a masked preview and the remote URLs
 * of the repos using it. An ssh key's preview is its public key. Each secret
 * is decrypted here so one that no longer decrypts is marked for
 * replacement.
 */
export async function listCredentialSummaries(owner: string): Promise<GitCredentialSummary[]> {
  const [creds, rows] = await Promise.all([listGitCredentials(owner), listRepos()])
  const out: GitCredentialSummary[] = []
  for (const c of creds) {
    const secret = await c.openSecret()
    const repos = rows.filter((r) => r.gitCredentialId === c.id).map((r) => r.remoteUrl)
    if (c.kind === 'https') {
      const preview = secret === undefined ? '(unreadable — replace it)'
        : secret.length > 4 ? '***' + secret.slice(-4) : '****'
      out.push({ id: c.id, name: c.name, kind: 'https', preview, repos })
    } else {
      const publicKey = c.publicKey ?? ''
      const preview = secret === undefined ? `${publicKey} (unreadable — replace it)` : publicKey
      out.push({ id: c.id, name: c.name, kind: 'ssh', preview, publicKey, repos })
    }
  }
  return out
}

/** One user's git credentials as the runtime takes them. */
export interface RuntimeGitCredentials {
  git: HttpsCredentialEntry[]
  ssh: SshCredentialEntry[]
}

/**
 * The git credentials handed to the runtime, keyed by their owner. Each
 * carries one grant per repo that uses it and project that links that repo,
 * or links a fork of it (docs/project-repos.md "Credentials per repo"),
 * read-only for a read-only repo or link and for an upstream, so egress uses it for
 * those projects' workspaces, toward those repos, and nothing else. A
 * credential is only ever usable by its owner's projects. Rows that don't
 * decrypt or that no project can use are left out.
 */
export async function runtimeGitCredentials(): Promise<Record<string, RuntimeGitCredentials>> {
  const [creds, projects, repos] = await Promise.all([listGitCredentials(), listProjectRows(), listRepos()])
  const repoOf = new Map(repos.map((r) => [r.id, r]))
  const out: Record<string, RuntimeGitCredentials> = {}
  for (const c of creds) {
    const grant = (projectId: string, repo: RepoRow, readOnly: boolean, ghToken: boolean): Array<RepoGrant & { knownHostsEntry: string }> => {
      if (repo.gitCredentialId !== c.id || repo.deletedAt !== undefined || !usableAssignment(repo, c)) return []
      const { host, path } = parseGitRemote(repo.remoteUrl)
      return [{ projectId, repoId: repo.id, host, path, readOnly, ghToken, knownHostsEntry: repo.knownHostsEntry ?? '' }]
    }
    const grants = projects.filter((p) => p.owner === c.owner).flatMap((p) => p.repos.flatMap((link) => {
      const { repo } = link
      // A fork's upstream is only ever read through it, and is its owner's
      // alone (docs/repo-forks.md "What a workspace can reach"). A project
      // that links the upstream itself has that link's grant instead: the
      // proxy takes a path's first grant, so two would race.
      const upstream = repo.upstreamRepoId !== null ? repoOf.get(repo.upstreamRepoId) : undefined
      const linksUpstream = upstream !== undefined && p.repos.some((l) => l.repo.id === upstream.id)
      return [
        ...grant(p.id, repo, link.readOnly || repo.readOnly, link.ghToken),
        ...(upstream !== undefined && upstream.owner === p.owner && !linksUpstream ? grant(p.id, upstream, true, false) : []),
      ]
    }))
    if (grants.length === 0) continue
    const secret = await c.openSecret()
    if (secret === undefined) continue
    const entry = out[c.owner] ??= { git: [], ssh: [] }
    if (c.kind === 'https') {
      entry.git.push({ token: secret, grants: grants.map(({ knownHostsEntry: _, ...grant }) => grant) })
      continue
    }
    entry.ssh.push({
      privateKey: encodeOpenSshPrivateKey(Buffer.from(secret, 'base64'), c.name),
      publicKey: c.publicKey ?? '',
      grants,
    })
  }
  return out
}
