import { ServerError } from '@yaac/shared/errors'
import { parseGitRemote, usableAssignment } from '@yaac/shared/git-remote'
import {
  getGitCredential,
  listGitCredentials,
  getRepo,
  setRepoGitCredential,
  updateRepoSettings,
  type GitCredentialRow,
  type RepoRow,
} from '#db'
import { fetchKnownHostsEntry, probePushAccess } from '#domain/git'
import type { ResolvedGitCredential } from '#domain/git'
import { encodeOpenSshPrivateKey } from '#lib/ssh-key'
import type { Actor } from '#domain/access'
import { ownRepo } from './access'
import { serverLog } from '#lib/log'

/**
 * A repo's git credential: assigning one of its owner's credentials
 * (`#domain/auth` keeps them) and resolving it for git.
 */

/**
 * Validate a git remote URL and return it parsed: one of the
 * `parseGitRemote` forms (https://, ssh:// or SCP-style). That refuses an
 * https URL carrying a user or token, which matters here: the URL is
 * stored on the row, shown to every user and written into checkouts, so a
 * secret belongs in a git credential instead.
 */
export function validateGitRemoteUrl(url: string): ReturnType<typeof parseGitRemote> {
  let parsed: ReturnType<typeof parseGitRemote>
  try {
    parsed = parseGitRemote(url)
  } catch (err) {
    throw new ServerError(
      'VALIDATION',
      err instanceof Error ? err.message : `Invalid git remote URL: "${url}"`,
    )
  }
  return parsed
}

/**
 * Check `remoteUrl` parses and one of `owner`'s credentials fits it, and
 * resolve that credential for git (another user's reads as missing): its
 * kind must match the remote's scheme and its secret must decrypt. For an
 * ssh key, the remote's host key is fetched (trust on first use) and
 * returned so the caller can store and show it.
 */
export async function resolveCredentialForRemote(
  owner: string,
  credentialId: string,
  remoteUrl: string,
): Promise<{ credential: ResolvedGitCredential; knownHostsEntry: string | null; name: string }> {
  const { scheme, host } = validateGitRemoteUrl(remoteUrl)
  const cred = await getGitCredential(credentialId)
  if (cred?.owner !== owner) throw new ServerError('NOT_FOUND', 'No such git credential.')
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
  if (cred.kind === 'https') return { credential: { kind: 'https', token: secret }, knownHostsEntry: null, name: cred.name }
  let knownHostsEntry: string
  try {
    knownHostsEntry = await fetchKnownHostsEntry(host)
  } catch (err) {
    throw new ServerError(
      'VALIDATION',
      `Could not fetch the host key for ${host}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return { credential: sshCredential(cred, knownHostsEntry), knownHostsEntry, name: cred.name }
}

function sshCredential(cred: GitCredentialRow, knownHostsEntry: string): ResolvedGitCredential {
  return { kind: 'ssh', id: cred.id, publicKey: cred.publicKey ?? '', knownHostsEntry }
}

/** Assign a repo its git credential, then probe whether it can push;
 *  returns the trusted host key. Only the repo's owner assigns one. */
export async function assignRepoCredential(
  principal: Actor,
  repoId: string,
  credentialId: string,
): Promise<{ knownHostsEntry: string | null }> {
  const repo = await ownRepo(principal, repoId)
  if (repo.hosted) {
    throw new ServerError('VALIDATION', `${repo.remoteUrl} is hosted by yaac, so it needs no git credential.`)
  }
  const { knownHostsEntry } = await resolveCredentialForRemote(repo.owner, credentialId, repo.remoteUrl)
  await setRepoGitCredential(repoId, credentialId, knownHostsEntry)
  await probeRepoPushAccess([repoId])
  return { knownHostsEntry }
}

/** The credential each repo can use, by repo id, for the listings. */
export async function repoCredentialNames(
  rows: RepoRow[],
): Promise<Map<string, { id: string; name: string }>> {
  const creds = new Map((await listGitCredentials()).map((c) => [c.id, c]))
  const out = new Map<string, { id: string; name: string }>()
  for (const row of rows) {
    const cred = row.gitCredentialId === null ? undefined : creds.get(row.gitCredentialId)
    if (usableAssignment(row, cred)) out.set(row.id, { id: cred.id, name: cred.name })
  }
  return out
}

/** The repo's git credential, resolved for git; null when it has none it
 *  can use. A hosted repo's is always `hosted`. */
export async function resolveRepoCredential(repo: RepoRow): Promise<ResolvedGitCredential | null> {
  if (repo.hosted) return { kind: 'hosted' }
  if (repo.gitCredentialId === null) return null
  const cred = await getGitCredential(repo.gitCredentialId)
  if (!usableAssignment(repo, cred)) return null
  // An undecryptable secret resolves to null rather than failing obscurely
  // at the remote; the store already logged which row.
  const secret = await cred.openSecret()
  if (secret === undefined) return null
  return cred.kind === 'https'
    ? { kind: 'https', token: secret }
    : sshCredential(cred, repo.knownHostsEntry ?? '')
}

/** The create error for a repo with no usable credential that needs one
 *  (`needsGitCredential`). */
export function missingCredentialError(repo: RepoRow): ServerError {
  return new ServerError(
    'VALIDATION',
    `${repo.remoteUrl} has no git credential. Assign one in Settings → Repos.`,
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

/*
 * Whether a repo's credential can push to its remote (docs/repo-forks.md
 * "Push access"), probed when the credential is assigned or replaced, once
 * a day while a workspace has a checkout of the repo, and on demand. A
 * refusal on a repo that is not read-only is the warning clients show;
 * nothing converts a repo on its own.
 */

/** How often a repo with running checkouts is probed again. */
const PROBE_INTERVAL_MS = 24 * 60 * 60_000

/** When each repo was last probed, by repo id. */
const lastProbeMs = new Map<string, number>()

/** Each repo's probe under way, which another caller joins. */
const probing = new Map<string, Promise<void>>()

/**
 * Probe each named repo that has something to probe (one on a git host,
 * not read-only, with a usable credential) and store a definite answer; an
 * unknown one, such as a network failure, leaves the stored answer as it
 * was. A caller joins a probe of the repo under way, and `unlessWithinMs`
 * skips a repo probed that recently. Answers each repo's push access
 * afterwards.
 */
export async function probeRepoPushAccess(
  repoIds: string[],
  opts: { unlessWithinMs?: number } = {},
): Promise<Map<string, 'yes' | 'no' | null>> {
  await Promise.all(repoIds.map(async (id) => {
    if (opts.unlessWithinMs !== undefined && Date.now() - (lastProbeMs.get(id) ?? 0) < opts.unlessWithinMs) return
    const running = probing.get(id) ?? probeOne(id).finally(() => probing.delete(id))
    probing.set(id, running)
    await running
  }))
  const out = new Map<string, 'yes' | 'no' | null>()
  for (const id of repoIds) {
    const repo = await getRepo(id)
    if (repo) out.set(id, repo.pushAccess)
  }
  return out
}

async function probeOne(id: string): Promise<void> {
  const repo = await getRepo(id)
  if (!repo || repo.hosted || repo.readOnly || repo.deletedAt !== undefined) return
  const credential = await resolveRepoCredential(repo)
  if (!credential) return
  lastProbeMs.set(id, Date.now())
  const answer = await probePushAccess(repo.remoteUrl, credential)
  if (answer !== null && answer !== repo.pushAccess) await updateRepoSettings(id, { pushAccess: answer })
}

/** Probe, in the background, each named repo not probed in the last day. */
export function probeStalePushAccess(repoIds: Iterable<string>): void {
  const now = Date.now()
  const stale = [...repoIds].filter((id) => now - (lastProbeMs.get(id) ?? 0) >= PROBE_INTERVAL_MS)
  if (stale.length === 0) return
  probeRepoPushAccess(stale).catch((err: unknown) => serverLog(`[git] daily push probe: ${String(err)}`))
}
