/**
 * The calls a workspace makes to `yaac.internal`, which the proxy relays to
 * the server's yaac-mama listener before any allowlist check: `yaac-mama`
 * itself, and the git remote of a project the server hosts
 * (docs/hosted-projects.md). The server decides what each may do; this
 * only picks the paths it answers and the headers it is sent.
 */

import type http from 'node:http'

/**
 * Hostname and path the in-workspace `yaac-mama` script POSTs to. It reaches
 * the transparent HTTP listener like any external name, and the proxy routes
 * on the Host header. Keep in sync with workspace-bin/yaac-mama.
 */
export const MAMA_MAGIC_HOST = 'yaac.internal'
export const MAMA_PATH = '/api/workspace/mama'
/** A hosted remote's smart-HTTP paths, as `HOSTED_REMOTE_PREFIX` in
 *  @yaac/shared/hosted-git names them. */
const HOSTED_GIT_PATH = /^\/api\/workspace\/git\/[0-9a-f-]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)(\?.*)?$/

/** Request headers git and yaac-mama need passed on. */
const FORWARDED_HEADERS = ['content-type', 'content-length', 'content-encoding', 'git-protocol', 'accept']

/**
 * The server URL a workspace's request to `yaac.internal` is relayed to,
 * or null when the server answers no such path. `mamaRelayUrl` is the
 * listener's yaac-mama URL; a hosted-git request keeps its own path and
 * query on that origin.
 */
export function relayTarget(reqUrl: string, mamaRelayUrl: string): string | null {
  if (reqUrl === MAMA_PATH) return mamaRelayUrl
  if (HOSTED_GIT_PATH.test(reqUrl)) return new URL(reqUrl, mamaRelayUrl).toString()
  return null
}

/** The headers a relayed request carries: the caller's identity, proof
 *  that the proxy sent it, and the forwarded request headers. */
export function relayHeaders(
  incoming: http.IncomingHttpHeaders,
  workspaceId: string,
  proxyAuthSecret: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    'authorization': `Bearer ${proxyAuthSecret}`,
    'x-yaac-workspace-id': workspaceId,
  }
  for (const name of FORWARDED_HEADERS) {
    if (incoming[name] !== undefined) headers[name] = incoming[name]
  }
  return headers
}
