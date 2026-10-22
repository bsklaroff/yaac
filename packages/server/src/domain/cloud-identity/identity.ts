import { ServerError } from '@yaac/shared/errors'
import { getProjectRow, listProjectRows, setProjectCloudIdentity } from '#db'
import { authorizeInstallOwner, type Actor } from '#domain/access'
import { workspaceDriver, workspacesSandboxed } from '#drivers/driver'
import { errorText, serverLog } from '#lib/log'
import { gcp } from './gcp'
import type { CloudIdentityProvider, HostIdentity } from './provider'
import type { CloudCredential } from '#drivers/contract'
import type { CloudIdentityInfo } from '@yaac/shared/types'

/**
 * Lending projects' workspaces a cloud identity (docs/cloud-identity.md).
 * The server finds its own identity once at start, mints a token for each
 * project whose `cloudIdentity` is set, refreshes it well before it
 * expires, and hands the whole set to the driver, whose egress proxy serves
 * it from a stand-in metadata server. The real metadata server stays out
 * of the workspaces' reach.
 */

const PROVIDERS: CloudIdentityProvider[] = [gcp]
/** Tokens are re-minted this long before they expire. */
const REFRESH_MARGIN_MS = 10 * 60_000
const REFRESH_INTERVAL_MS = 60_000

/** The cloud the server found itself on, and its identity there. */
let host: { provider: CloudIdentityProvider; identity: HostIdentity } | null = null
/** Each project's current token, with the setting it was minted for. */
const minted = new Map<string, { setting: string; credential: CloudCredential }>()
/** What the driver last accepted, so an unchanged set is not re-sent. */
let pushed: string | null = null

/** The identity a setting names: `host` is the server's own. */
function resolveSetting(setting: string, own: HostIdentity): string {
  return setting === 'host' ? own.identity : setting
}

async function mint(setting: string): Promise<CloudCredential> {
  if (!host) throw new Error('no cloud identity was found at start')
  const identity = resolveSetting(setting, host.identity)
  const token = await host.provider.obtain(identity, host.identity)
  return { provider: host.provider.name, identity, ...token, hostProject: host.identity.project }
}

/** Re-mint what is near expiry, drop what is no longer set, and send the
 *  set to the driver if it changed. A failed mint keeps the old token,
 *  which the proxy stops serving once it expires. */
async function refreshOnce(): Promise<Error | undefined> {
  const rows = await listProjectRows()
  const wanted = new Map(rows.flatMap((r) => (r.cloudIdentity !== undefined ? [[r.id, r.cloudIdentity]] : [])))
  for (const projectId of minted.keys()) {
    if (minted.get(projectId)?.setting !== wanted.get(projectId)) minted.delete(projectId)
  }
  if (host) {
    for (const [projectId, setting] of wanted) {
      const current = minted.get(projectId)
      if (current && current.credential.expiresAt - Date.now() > REFRESH_MARGIN_MS) continue
      try {
        minted.set(projectId, { setting, credential: await mint(setting) })
      } catch (err) {
        serverLog(`[server] cloud identity for project ${projectId}: ${errorText(err)}`)
      }
    }
  }
  const byProject = Object.fromEntries([...minted].map(([id, { credential }]) => [id, credential]))
  const body = JSON.stringify(byProject)
  if (body === pushed) return undefined
  try {
    await workspaceDriver().syncCloudCredentials(byProject)
    pushed = body
    return undefined
  } catch (err) {
    serverLog(`[server] cloud credential push to the runtime failed: ${errorText(err)}`)
    return err instanceof Error ? err : new Error(String(err))
  }
}

// One refresh at a time; a request during one is served by one more.
let inflight: Promise<Error | undefined> | null = null
let rerun = false

function refreshCloudCredentials(): Promise<Error | undefined> {
  if (inflight) {
    rerun = true
    return inflight
  }
  inflight = (async () => {
    try {
      let failure: Error | undefined
      do {
        rerun = false
        failure = await refreshOnce()
      } while (rerun)
      return failure
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Find the server's cloud identity, push every project's token, and keep
 * them fresh until `signal` aborts. Only a driver that mediates egress has
 * a proxy to serve them; a host server's workspaces use its own
 * credentials directly. Resolves after the first push.
 */
export async function startCloudIdentity(signal: AbortSignal): Promise<void> {
  if (!workspacesSandboxed()) return
  for (const provider of PROVIDERS) {
    const identity = await provider.detect()
    if (identity) {
      host = { provider, identity }
      serverLog(`[server] cloud identity: ${provider.name}, running as ${identity.identity}`)
      break
    }
  }
  await refreshCloudCredentials()
  const timer = setInterval(() => { void refreshCloudCredentials() }, REFRESH_INTERVAL_MS)
  timer.unref?.()
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
}

/** The cloud the server found, its own identity there, and whether the
 *  caller may set a project's. */
export function cloudIdentityInfo(principal: Actor): CloudIdentityInfo {
  let canSet = true
  try {
    authorizeInstallOwner(principal)
  } catch {
    canSet = false
  }
  return { provider: host?.provider.name ?? null, hostIdentity: host?.identity.identity ?? null, canSet }
}

/**
 * Set (or with null, clear) the cloud identity a project's workspaces act
 * as, for the install owner only. A token is minted before anything is
 * saved, so an identity the server cannot act as is refused with the
 * cloud's reason. Resolves to the identity the workspaces now act as.
 */
export async function assignProjectCloudIdentity(
  principal: Actor,
  projectId: string,
  setting: string | null,
): Promise<{ identity: string | null }> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `Project "${projectId}" not found`)
  authorizeInstallOwner(principal)
  let identity: string | null = null
  if (setting !== null) {
    if (!host) {
      throw new ServerError('NOT_SUPPORTED', 'This server found no cloud identity to lend: it is not running '
        + 'on a cloud yaac supports (GCP) with a service account attached.')
    }
    const problem = setting === 'host' ? null : host.provider.validateId(setting)
    if (problem) throw new ServerError('VALIDATION', problem)
    let credential: CloudCredential
    try {
      credential = await mint(setting)
    } catch (err) {
      throw new ServerError('VALIDATION', `Could not get a token for ${resolveSetting(setting, host.identity)}: ${errorText(err)}`)
    }
    minted.set(projectId, { setting, credential })
    identity = credential.identity
  }
  await setProjectCloudIdentity(projectId, setting)
  const failure = await refreshCloudCredentials()
  if (failure) {
    throw new ServerError('RUNTIME_UNAVAILABLE', 'The cloud identity was saved, but the egress proxy could not '
      + `be updated, so running workspaces do not have it yet: ${failure.message}. It is retried every minute.`)
  }
  return { identity }
}

/** Forget the detected cloud and every token, for tests. */
export function resetCloudIdentityForTests(): void {
  host = null
  minted.clear()
  pushed = null
}
