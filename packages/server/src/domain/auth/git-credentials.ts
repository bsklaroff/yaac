import { ServerError } from '@yaac/shared/errors'
import { parseGitRemote, usableAssignment } from '@yaac/shared/git-remote'
import {
  deleteGitCredential,
  getGitCredential,
  insertGitCredential,
  listGitCredentials,
  listProjectRows,
  renameGitCredential,
  replaceGitCredential,
  type GitCredentialRow,
} from '#db'
import { encodeOpenSshPrivateKey, generateSshKey, withKeyComment } from '#lib/ssh-key'
import type { GitCredentialSummary } from '@yaac/shared/types'
import type { HttpsCredentialEntry, SshCredentialEntry } from '#drivers/contract'

/**
 * A user's git credentials (docs/git-credentials.md): HTTPS tokens and
 * generated SSH keys, stored under a name and assigned to projects by
 * `#domain/projects`.
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
 * is assigned to a project.
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
 * newly generated key), keeping its name and project assignments. For a
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

/** Delete one of `owner`'s credentials; the projects that used it are left
 *  with none. */
export async function removeCredential(owner: string, id: string): Promise<void> {
  await ownCredential(owner, id)
  if (!await deleteGitCredential(id)) throw new ServerError('NOT_FOUND', 'No such git credential.')
}

/**
 * Every credential of `owner`'s with a masked preview and the projects using
 * it. An ssh key's preview is its public key. Each secret is decrypted here
 * so one that no longer decrypts is marked for replacement.
 */
export async function listCredentialSummaries(owner: string): Promise<GitCredentialSummary[]> {
  const [creds, rows] = await Promise.all([listGitCredentials(owner), listProjectRows()])
  const out: GitCredentialSummary[] = []
  for (const c of creds) {
    const secret = await c.openSecret()
    const projects = rows.filter((r) => r.gitCredentialId === c.id).map((r) => r.id)
    if (c.kind === 'https') {
      const preview = secret === undefined ? '(unreadable — replace it)'
        : secret.length > 4 ? '***' + secret.slice(-4) : '****'
      out.push({ id: c.id, name: c.name, kind: 'https', preview, projects })
    } else {
      const publicKey = c.publicKey ?? ''
      const preview = secret === undefined ? `${publicKey} (unreadable — replace it)` : publicKey
      out.push({ id: c.id, name: c.name, kind: 'ssh', preview, publicKey, projects })
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
 * The git credentials handed to the runtime, keyed by their owner, each with
 * the projects allowed to use it, so egress gives it only to those projects'
 * workspaces. A credential is only ever usable by its owner's projects. Rows
 * that don't decrypt or that no project can use are left out.
 */
export async function runtimeGitCredentials(): Promise<Record<string, RuntimeGitCredentials>> {
  const [creds, rows] = await Promise.all([listGitCredentials(), listProjectRows()])
  const out: Record<string, RuntimeGitCredentials> = {}
  for (const c of creds) {
    const users = rows.filter((r) => r.gitCredentialId === c.id && usableAssignment(r, c))
    if (users.length === 0) continue
    const secret = await c.openSecret()
    if (secret === undefined) continue
    const entry = out[c.owner] ??= { git: [], ssh: [] }
    if (c.kind === 'https') {
      entry.git.push({ token: secret, projects: users.map((r) => r.id) })
      continue
    }
    entry.ssh.push({
      privateKey: encodeOpenSshPrivateKey(Buffer.from(secret, 'base64'), c.name),
      publicKey: c.publicKey ?? '',
      projects: users.map((r) => ({
        projectId: r.id,
        host: parseGitRemote(r.remoteUrl).host,
        knownHostsEntry: r.knownHostsEntry ?? '',
      })),
    })
  }
  return out
}
