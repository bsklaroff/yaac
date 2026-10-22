import type { CloudIdentityProvider, HostIdentity, ObtainedToken } from './provider'

/**
 * Google Cloud: the server's own service account, read from the GCE (or
 * GKE) metadata server, and any account it may impersonate through IAM
 * Credentials `generateAccessToken`, which needs
 * `roles/iam.serviceAccountTokenCreator` on that account.
 */

/** By address, since the server pod resolves names through cluster DNS. */
const METADATA_ORIGIN = 'http://169.254.169.254'
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' }
/** Off GCE the address may not answer at all; detection must not stall
 *  server start for long. */
const DETECT_TIMEOUT_MS = 2_000
const REQUEST_TIMEOUT_MS = 10_000
const IAM_CREDENTIALS = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const SERVICE_ACCOUNT = /^[a-z0-9.+_-]+@[a-z0-9.-]+\.gserviceaccount\.com$/

async function metadata(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const res = await fetch(`${METADATA_ORIGIN}/computeMetadata/v1/${path}`, {
    headers: METADATA_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  })
  // Another cloud's metadata server at the same address answers without it.
  if (res.headers.get('metadata-flavor') !== 'Google') throw new Error('not a GCE metadata server')
  if (!res.ok) throw new Error(`metadata ${path} answered ${String(res.status)}`)
  return res
}

/** The message in a Google API error body, else the status. */
async function apiError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
  return body?.error?.message ?? `HTTP ${String(res.status)}`
}

async function hostToken(): Promise<ObtainedToken> {
  const body = await (await metadata('instance/service-accounts/default/token')).json() as {
    access_token: string
    expires_in: number
  }
  return { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
}

export const gcp: CloudIdentityProvider = {
  name: 'gcp',

  async detect(): Promise<HostIdentity | null> {
    try {
      const read = async (path: string): Promise<string> => (await (await metadata(path, DETECT_TIMEOUT_MS)).text()).trim()
      return {
        identity: await read('instance/service-accounts/default/email'),
        project: { id: await read('project/project-id'), number: await read('project/numeric-project-id') },
      }
    } catch {
      return null
    }
  },

  validateId(id) {
    return SERVICE_ACCOUNT.test(id) ? null : `"${id}" is not a service account email (name@project.iam.gserviceaccount.com)`
  },

  async obtain(id, host) {
    const own = await hostToken()
    if (id === host.identity) return own
    const res = await fetch(`${IAM_CREDENTIALS}/${encodeURIComponent(id)}:generateAccessToken`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${own.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: [SCOPE] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`${host.identity} cannot impersonate ${id}: ${await apiError(res)}`)
    const body = await res.json() as { accessToken: string; expireTime: string }
    return { accessToken: body.accessToken, expiresAt: Date.parse(body.expireTime) }
  },
}
