import { ServerError } from '@yaac/shared/errors'
import { parseGitRemote, usableAssignment } from '@yaac/shared/git-remote'
import {
  getGitCredential,
  getProjectRow,
  listGitCredentials,
  setProjectGitCredential,
  type GitCredentialRow,
  type ProjectRow,
} from '#db'
import { fetchKnownHostsEntry } from '#domain/git'
import type { ResolvedGitCredential } from '#domain/git'
import { encodeOpenSshPrivateKey } from '#lib/ssh-key'
import { authorizeProject, type Actor } from '#domain/access'

/**
 * A project's git credential: assigning one of its owner's credentials
 * (`#domain/auth` keeps them) and resolving it for git.
 */

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
  const cred = await getGitCredential(credentialId)
  if (cred?.owner !== owner) throw new ServerError('NOT_FOUND', 'No such git credential.')
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
  if (row.hosted) {
    throw new ServerError('VALIDATION', `"${row.name}" is hosted by yaac, so it needs no git credential.`)
  }
  const { knownHostsEntry } = await resolveCredentialForRemote(row.owner, credentialId, row.remoteUrl)
  await setProjectGitCredential(projectId, credentialId, knownHostsEntry)
  return { knownHostsEntry }
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
 *  it can use. A hosted project's is always `hosted`. */
export async function resolveProjectCredential(projectId: string): Promise<ResolvedGitCredential | null> {
  const row = await getProjectRow(projectId)
  if (row?.hosted === true) return { kind: 'hosted' }
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
