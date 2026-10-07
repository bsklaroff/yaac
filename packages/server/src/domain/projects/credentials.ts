import { ServerError } from '@yaac/shared/errors'
import {
  deleteGitCredential,
  getGitCredential,
  getProjectRow,
  insertGitCredential,
  listGitCredentials,
  listProjectRows,
  renameGitCredential,
  replaceGitCredential,
  setProjectGitCredential,
  type GitCredentialRow,
  type ProjectRow,
} from '#db'
import { fetchKnownHostsEntry } from '#domain/git'
import type { ResolvedGitCredential } from '#domain/git'
import { encodeOpenSshPrivateKey, generateSshKey, withKeyComment } from '#lib/ssh-key'
import type { GitCredentialSummary } from '@yaac/shared/types'
import type { HttpsCredentialEntry, SshCredentialEntry } from '#drivers/contract'
import { authorizeProject, type Actor } from '#domain/access'

export interface ParsedGitRemote {
  scheme: 'https' | 'ssh'
  host: string
  path: string
}

// The path may not start with `/` (`scheme://`) or `:` (`helper::`): git
// would read either as a transport, and `ext::` runs a command.
const SCP_REGEX = /^(?:([\w._-]+)@)?([\w.-]+):(?![/:])(.+)$/

/**
 * Parse a git remote URL in one of two forms:
 *   - https://<host>/<path>[.git]
 *   - SCP-style: [user@]<host>:<path>[.git]
 * `<path>` may be any depth. Throws on ssh://, http://, explicit ports, or
 * unparseable input. A trailing slash is stripped so the last path segment
 * (used for the project name) is the repo name.
 */
export function parseGitRemote(remoteUrl: string): ParsedGitRemote {
  if (remoteUrl.startsWith('ssh://')) {
    throw new Error(
      'ssh:// URLs are not supported. Use SCP-style: git@host:path/to/repo',
    )
  }
  if (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://')) {
    const url = new URL(remoteUrl)
    if (url.protocol !== 'https:') {
      throw new Error(`Only HTTPS URLs are supported, got "${url.protocol}"`)
    }
    if (url.port) {
      throw new Error(`Custom HTTPS ports are not supported: "${remoteUrl}"`)
    }
    const path = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '')
    if (!path) {
      throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
    }
    return { scheme: 'https', host: url.hostname, path }
  }
  const m = SCP_REGEX.exec(remoteUrl)
  if (m) {
    const host = m[2]
    const path = m[3].replace(/\/$/, '').replace(/\.git$/, '')
    if (!path) {
      throw new Error(`Cannot parse repo path from URL: ${remoteUrl}`)
    }
    return { scheme: 'ssh', host, path }
  }
  throw new Error(`Unrecognized git remote URL: "${remoteUrl}"`)
}

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
 * Generate and store an SSH key under a name (docs/git-credentials.md).
 * Returns the public key for the user to register with their git host. No
 * host is contacted until the key is assigned to a project.
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
 * Check one of `owner`'s credentials fits `remoteUrl` and resolve it for
 * git (another user's reads as missing): its kind must
 * match the remote's scheme and its secret must decrypt. For an ssh key, the
 * remote's host key is fetched (trust on first use) and returned so the
 * caller can store and show it.
 */
export async function resolveCredentialForRemote(
  owner: string,
  credentialId: string,
  remoteUrl: string,
): Promise<{ credential: ResolvedGitCredential; knownHostsEntry: string | null }> {
  const cred = await ownCredential(owner, credentialId)
  const { scheme, host } = parseGitRemote(remoteUrl)
  if (cred.kind !== scheme) {
    throw new ServerError(
      'VALIDATION',
      scheme === 'ssh'
        ? `${remoteUrl} is an SSH remote; it needs an SSH key, not a token.`
        : `${remoteUrl} is an HTTPS remote; it needs a token, not an SSH key.`,
    )
  }
  const secret = await cred.openSecret()
  if (secret === undefined) {
    throw new ServerError('VALIDATION', `The git credential "${cred.name}" cannot be opened; replace it.`)
  }
  if (cred.kind === 'https') return { credential: { kind: 'https', token: secret }, knownHostsEntry: null }
  let knownHostsEntry: string
  try {
    knownHostsEntry = await fetchKnownHostsEntry(host)
  } catch (err) {
    throw new ServerError(
      'VALIDATION',
      `Could not fetch the host key for ${host}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return { credential: sshCredential(cred, knownHostsEntry), knownHostsEntry }
}

function sshCredential(cred: GitCredentialRow, knownHostsEntry: string): ResolvedGitCredential {
  return { kind: 'ssh', id: cred.id, publicKey: cred.publicKey ?? '', knownHostsEntry }
}

/** Assign a project its git credential; returns the trusted host key. */
export async function assignProjectCredential(
  principal: Actor,
  projectId: string,
  credentialId: string,
): Promise<{ knownHostsEntry: string | null }> {
  const row = await getProjectRow(projectId)
  if (!row) throw new ServerError('NOT_FOUND', `Project "${projectId}" not found`)
  await authorizeProject(principal, projectId)
  const { knownHostsEntry } = await resolveCredentialForRemote(row.owner, credentialId, row.remoteUrl)
  await setProjectGitCredential(projectId, credentialId, knownHostsEntry)
  return { knownHostsEntry }
}

/**
 * Whether a project's credential is usable as is: it exists, its kind matches
 * the remote's scheme, and an ssh key has a host key. Anything else (such as
 * a changed remote) counts as no credential, so the user is asked for one.
 */
function usableAssignment(row: ProjectRow, cred: GitCredentialRow | undefined): cred is GitCredentialRow {
  if (cred?.owner !== row.owner) return false
  let scheme: 'https' | 'ssh'
  try {
    scheme = parseGitRemote(row.remoteUrl).scheme
  } catch {
    return false
  }
  return cred.kind === scheme && (scheme === 'https' || row.knownHostsEntry !== null)
}

/** The credential each project can use, by project id — for the listing. */
export async function projectCredentialNames(
  rows: ProjectRow[],
): Promise<Map<string, { id: string; name: string }>> {
  const creds = new Map((await listGitCredentials()).map((c) => [c.id, c]))
  const out = new Map<string, { id: string; name: string }>()
  for (const row of rows) {
    const cred = row.gitCredentialId === null ? undefined : creds.get(row.gitCredentialId)
    if (usableAssignment(row, cred)) out.set(row.id, { id: cred.id, name: cred.name })
  }
  return out
}

/** The project's git credential, resolved for git; null when it has none
 *  it can use. */
export async function resolveProjectCredential(projectId: string): Promise<ResolvedGitCredential | null> {
  const row = await getProjectRow(projectId)
  if (row?.gitCredentialId == null) return null
  const cred = await getGitCredential(row.gitCredentialId)
  if (!usableAssignment(row, cred)) return null
  // An undecryptable secret resolves to null rather than failing obscurely
  // at the remote; the store already logged which row.
  const secret = await cred.openSecret()
  if (secret === undefined) return null
  return cred.kind === 'https'
    ? { kind: 'https', token: secret }
    : sshCredential(cred, row.knownHostsEntry ?? '')
}

/** The create error for a project with no usable credential. */
export function missingCredentialError(projectName: string): ServerError {
  return new ServerError(
    'VALIDATION',
    `Project "${projectName}" has no git credential. Assign one in Settings → Git credentials.`,
  )
}

/**
 * An ssh credential's private key in `ssh-add -` format, for a workspace
 * with no proxy to sign for it (it loads the key into its own agent). Never
 * written to disk.
 */
export async function sshKeyMaterial(credentialId: string): Promise<string> {
  const cred = await getGitCredential(credentialId)
  const seed = await cred?.openSecret()
  if (!cred || seed === undefined) {
    throw new ServerError('VALIDATION', 'The SSH key cannot be opened; assign a new one.')
  }
  return encodeOpenSshPrivateKey(Buffer.from(seed, 'base64'), cred.name)
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
 * The git credentials handed to the runtime, keyed by the user whose
 * projects use them, each with the projects allowed to use it, so egress
 * gives it only to those projects' workspaces. Rows that don't decrypt or
 * that no project can use are left out.
 */
export async function runtimeGitCredentials(): Promise<Record<string, RuntimeGitCredentials>> {
  const [creds, rows] = await Promise.all([listGitCredentials(), listProjectRows()])
  const out: Record<string, RuntimeGitCredentials> = {}
  for (const c of creds) {
    const users = rows.filter((r) => r.gitCredentialId === c.id && usableAssignment(r, c))
    if (users.length === 0) continue
    const secret = await c.openSecret()
    if (secret === undefined) continue
    for (const owner of new Set(users.map((r) => r.owner))) {
      const mine = users.filter((r) => r.owner === owner)
      const entry = out[owner] ??= { git: [], ssh: [] }
      if (c.kind === 'https') {
        entry.git.push({ token: secret, projects: mine.map((r) => r.id) })
        continue
      }
      entry.ssh.push({
        privateKey: encodeOpenSshPrivateKey(Buffer.from(secret, 'base64'), c.name),
        publicKey: c.publicKey ?? '',
        projects: mine.map((r) => ({
          projectId: r.id,
          host: parseGitRemote(r.remoteUrl).host,
          knownHostsEntry: r.knownHostsEntry ?? '',
        })),
      })
    }
  }
  return out
}
