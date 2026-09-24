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

/**
 * Parse a git remote URL. Two forms are supported:
 *   - https://<host>/<path>[.git]
 *   - SCP-style: [user@]<host>:<path>[.git]
 * `<path>` may be any depth — a single segment (e.g. Gerrit-style `repo`) or
 * a deeper path (e.g. `group/sub/repo`). Throws on ssh://, http://, explicit
 * ports, or unparseable input. A trailing slash on `<path>` is stripped —
 * left in, `path.split('/').pop()` (used to derive the project slug) would
 * return an empty string instead of the repo name.
 */
export interface ParsedGitRemote {
  scheme: 'https' | 'ssh'
  host: string
  path: string
}

const SCP_REGEX = /^(?:([\w._-]+)@)?([\w.-]+):(?!\/)(.+)$/

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

/** Store an HTTPS token under a name. */
export async function addHttpsCredential(params: { name: string; token: string }): Promise<{ id: string }> {
  const token = params.token.trim()
  if (!token) throw new ServerError('VALIDATION', 'Token cannot be empty.')
  const row = await insertGitCredential({ name: validName(params.name), kind: 'https', secret: token })
  return { id: row.id }
}

/**
 * Generate an SSH key under a name and seal it (docs/git-credentials.md).
 * The answer is the public half, for the user to register with their git
 * host before a project uses the key — nothing is fetched from any host
 * here, since the key is not tied to one until it is assigned.
 */
export async function generateSshCredential(params: { name: string }): Promise<{ id: string; publicKey: string }> {
  const name = validName(params.name)
  const key = generateSshKey(name)
  const row = await insertGitCredential({
    name, kind: 'ssh', secret: key.seed.toString('base64'), publicKey: key.publicKey,
  })
  return { id: row.id, publicKey: key.publicKey }
}

/**
 * Rename a credential. For a key that also re-comments its public line —
 * which authenticates nothing, so a copy already registered with a host
 * keeps working under its old comment.
 */
export async function renameCredential(id: string, rawName: string): Promise<void> {
  const name = validName(rawName)
  const cred = await getGitCredential(id)
  if (!cred) throw new ServerError('NOT_FOUND', 'No such git credential.')
  const publicKey = cred.publicKey === null ? null : withKeyComment(cred.publicKey, name)
  await renameGitCredential(id, name, publicKey)
}

/**
 * Replace a credential with a new secret of its kind — a pasted token, or a
 * freshly generated key — keeping its name and every project assigned to
 * it. A key's answer is its new public half, which the user registers with
 * the git host before those projects' git works again.
 */
export async function replaceCredential(
  id: string,
  params: { token?: string },
): Promise<{ id: string; publicKey?: string }> {
  const cred = await getGitCredential(id)
  if (!cred) throw new ServerError('NOT_FOUND', 'No such git credential.')
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

/** Delete a credential; the projects that used it are left with none. */
export async function removeCredential(id: string): Promise<void> {
  if (!await deleteGitCredential(id)) throw new ServerError('NOT_FOUND', 'No such git credential.')
}

/**
 * Check a credential can authenticate `remoteUrl`, and resolve it for git:
 * the kind must match the remote's scheme, the secret must open, and an ssh
 * key gets the remote's host key — fetched here, trust on first use, and
 * handed back so the caller can store it and show it.
 */
export async function resolveCredentialForRemote(
  credentialId: string,
  remoteUrl: string,
): Promise<{ credential: ResolvedGitCredential; knownHostsEntry: string | null }> {
  const cred = await getGitCredential(credentialId)
  if (!cred) throw new ServerError('NOT_FOUND', 'No such git credential.')
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

/** Assign a project its git credential; answers the host key it trusted. */
export async function assignProjectCredential(
  slug: string,
  credentialId: string,
): Promise<{ knownHostsEntry: string | null }> {
  const row = await getProjectRow(slug)
  if (!row) throw new ServerError('NOT_FOUND', `Project "${slug}" not found`)
  const { knownHostsEntry } = await resolveCredentialForRemote(credentialId, row.remoteUrl)
  await setProjectGitCredential(slug, credentialId, knownHostsEntry)
  return { knownHostsEntry }
}

/**
 * Whether a project's assignment is one git can use as it stands: the
 * credential exists, its kind is the remote's scheme, and a key has the
 * host key it was assigned with. Anything else — a remote that changed
 * under it included — reads as no credential, so the project asks for one
 * rather than failing somewhere less visible.
 */
function usableAssignment(row: ProjectRow, cred: GitCredentialRow | undefined): cred is GitCredentialRow {
  if (!cred) return false
  let scheme: 'https' | 'ssh'
  try {
    scheme = parseGitRemote(row.remoteUrl).scheme
  } catch {
    return false
  }
  return cred.kind === scheme && (scheme === 'https' || row.knownHostsEntry !== null)
}

/** The credential each project can use, by slug — for the listing. */
export async function projectCredentialNames(
  rows: ProjectRow[],
): Promise<Map<string, { id: string; name: string }>> {
  const creds = new Map((await listGitCredentials()).map((c) => [c.id, c]))
  const out = new Map<string, { id: string; name: string }>()
  for (const row of rows) {
    const cred = row.gitCredentialId === null ? undefined : creds.get(row.gitCredentialId)
    if (usableAssignment(row, cred)) out.set(row.slug, { id: cred.id, name: cred.name })
  }
  return out
}

/** The project's git credential, resolved for git; null when it has none
 *  it can use. */
export async function resolveProjectCredential(slug: string): Promise<ResolvedGitCredential | null> {
  const row = await getProjectRow(slug)
  if (row?.gitCredentialId == null) return null
  const cred = await getGitCredential(row.gitCredentialId)
  if (!usableAssignment(row, cred)) return null
  // An unreadable secret resolves to nothing rather than to a credential
  // git would fail with at the remote, where the cause is invisible; the
  // store has already said which row.
  const secret = await cred.openSecret()
  if (secret === undefined) return null
  return cred.kind === 'https'
    ? { kind: 'https', token: secret }
    : sshCredential(cred, row.knownHostsEntry ?? '')
}

/** The error a project with no usable credential answers a create with. */
export function missingCredentialError(slug: string): ServerError {
  return new ServerError(
    'VALIDATION',
    `Project "${slug}" has no git credential. Assign one in Settings → Git credentials.`,
  )
}

/**
 * The private key of an ssh credential, in the form `ssh-add -` reads — for
 * a workspace on a substrate with no proxy to sign for it, which loads it
 * into an agent of its own. Opened here and handed on, never written.
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
 * Every credential with a masked preview and the projects that use it.
 *
 * An ssh row's preview is its public key: that is the half the user needs
 * to see, and the only half there is to show. Each row is opened here — a
 * user-initiated listing is the right place — so one the secret key no
 * longer opens is marked as needing replacement rather than listed like a
 * good one.
 */
export async function listCredentialSummaries(): Promise<GitCredentialSummary[]> {
  const [creds, rows] = await Promise.all([listGitCredentials(), listProjectRows()])
  const out: GitCredentialSummary[] = []
  for (const c of creds) {
    const secret = await c.openSecret()
    const projects = rows.filter((r) => r.gitCredentialId === c.id).map((r) => r.slug)
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

/**
 * The git half of what the runtime is handed: each credential with the
 * projects entitled to it, so an egress path can give it to a worktree of
 * those projects and no other. Opens every secret, because that is what it
 * is for; a row that will not open, or that no project can use, is left out.
 */
export async function runtimeGitCredentials(): Promise<{ git: HttpsCredentialEntry[]; ssh: SshCredentialEntry[] }> {
  const [creds, rows] = await Promise.all([listGitCredentials(), listProjectRows()])
  const git: HttpsCredentialEntry[] = []
  const ssh: SshCredentialEntry[] = []
  for (const c of creds) {
    const users = rows.filter((r) => r.gitCredentialId === c.id && usableAssignment(r, c))
    if (users.length === 0) continue
    const secret = await c.openSecret()
    if (secret === undefined) continue
    if (c.kind === 'https') {
      git.push({ token: secret, projects: users.map((r) => r.slug) })
      continue
    }
    ssh.push({
      privateKey: encodeOpenSshPrivateKey(Buffer.from(secret, 'base64'), c.name),
      publicKey: c.publicKey ?? '',
      projects: users.map((r) => ({
        slug: r.slug,
        host: parseGitRemote(r.remoteUrl).host,
        knownHostsEntry: r.knownHostsEntry ?? '',
      })),
    })
  }
  return { git, ssh }
}
