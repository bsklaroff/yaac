/**
 * The stand-in cloud metadata server (docs/cloud-identity.md). A workspace's
 * plain-HTTP request to the metadata address or name is answered here and
 * never dialed upstream, so the real metadata server stays out of reach
 * whatever the allowlist says.
 *
 * A project with a cloud credential gets just enough of GCP's metadata API
 * for gcloud and the Google auth libraries to find a service account and
 * fetch its token, which is a placeholder the MITM path swaps for the real
 * one on `*.googleapis.com` (injection.ts). Everything else is 404, and a
 * project without a credential gets a 404 with no `Metadata-Flavor` header,
 * which those libraries read as "not on GCE".
 */

import type { CloudCredential } from './objects'

export const PLACEHOLDER_CLOUD_TOKEN = 'yaac-ph-cloud-token'

/** The address every major cloud serves metadata on, and GCP's names. */
const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const PREFIX = '/computeMetadata/v1/'

export function isMetadataHost(hostname: string): boolean {
  return METADATA_HOSTS.has(hostname)
}

/** Whether the proxy swaps the real token in on requests to `hostname`. */
export function isCloudApiHost(hostname: string): boolean {
  return hostname.endsWith('.googleapis.com')
}

export type MetadataReply = { status: number; headers: Record<string, string>; body: string }

function reply(status: number, body: string, json = false): MetadataReply {
  return {
    status,
    headers: { 'Metadata-Flavor': 'Google', 'Content-Type': json ? 'application/json' : 'text/plain' },
    body,
  }
}

/**
 * The answer to one metadata request from a workspace whose project has
 * `cred` (undefined for none). Like the real server, a request without
 * `Metadata-Flavor: Google` is refused, so a page a browser was tricked
 * into loading cannot read it.
 */
export function answerMetadata(
  method: string,
  url: string,
  metadataFlavor: string | undefined,
  cred: CloudCredential | undefined,
  now = Date.now(),
): MetadataReply {
  if (!cred) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'no cloud identity' }
  if (metadataFlavor !== 'Google') return reply(403, 'Missing Metadata-Flavor:Google header.')
  if (method !== 'GET') return reply(405, 'Method not allowed')

  const { pathname, searchParams } = new URL(url, 'http://metadata')
  if (pathname === '/' || pathname === PREFIX || pathname === PREFIX.slice(0, -1)) return reply(200, 'computeMetadata/\n')
  if (!pathname.startsWith(PREFIX)) return reply(404, 'Not found')
  const rest = pathname.slice(PREFIX.length)

  if (rest === 'project/project-id') return reply(200, cred.hostProject.id)
  if (rest === 'project/numeric-project-id') return reply(200, cred.hostProject.number)

  const account = { aliases: ['default'], email: cred.identity, scopes: [SCOPE] }
  if (rest === 'instance/service-accounts/' || rest === 'instance/service-accounts') {
    return searchParams.get('recursive') === 'true'
      ? reply(200, JSON.stringify({ default: account, [cred.identity]: account }), true)
      : reply(200, `default/\n${cred.identity}/\n`)
  }
  const match = /^instance\/service-accounts\/([^/]+)\/(.*)$/.exec(rest)
  if (!match || (match[1] !== 'default' && match[1] !== cred.identity)) return reply(404, 'Not found')
  switch (match[2]) {
    case '':
      return searchParams.get('recursive') === 'true'
        ? reply(200, JSON.stringify(account), true)
        : reply(200, 'aliases\nemail\nscopes\ntoken\n')
    case 'email':
      return reply(200, cred.identity)
    case 'aliases':
      return reply(200, 'default\n')
    case 'scopes':
      return reply(200, `${SCOPE}\n`)
    case 'token': {
      const expiresIn = Math.floor((cred.expiresAt - now) / 1000)
      // Failing now beats a placeholder that would only fail at the API.
      if (expiresIn <= 0) return reply(503, 'The cloud token for this project could not be refreshed.')
      return reply(200, JSON.stringify({ access_token: PLACEHOLDER_CLOUD_TOKEN, expires_in: expiresIn, token_type: 'Bearer' }), true)
    }
    default:
      return reply(404, 'Not found')
  }
}
