import { hc } from 'hono/client'
import type { buildApp, AppType } from '@yaac/server/main/server'
import type { SpawnedServer } from '#cli'

type ServerApp = ReturnType<typeof buildApp>

/**
 * Wrap an in-memory `buildApp(...)` instance as a raw typed Hono API client.
 * Dispatches through `app.fetch`, so no port is bound. Uses a loopback host
 * so the server's Host-header check accepts it and identifies the caller as
 * local (the real CLI likewise targets 127.0.0.1).

 *
 * Raw on purpose: unlike the app's `createApiClient`, this neither throws on
 * non-2xx nor unwraps the body, so contract tests can assert status codes and
 * read `res.json()` themselves.
 */
export function makeTestApiClient(app: ServerApp) {
  return hc<AppType>('http://127.0.0.1/', {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(new Request(input as string | URL, init)),
  })
}

/**
 * Raw typed Hono API client that speaks to a real spawned server subprocess
 * over HTTP. Mirrors `makeTestApiClient` (also raw) but issues real network
 * calls against `server.lock.port`.
 */
export function makeServerApiClient(server: SpawnedServer) {
  return hc<AppType>(`http://127.0.0.1:${server.lock.port}/`)
}

/**
 * The headers `tailscale serve` puts on a request it forwards from a
 * user-owned tailnet device, addressed as `host` — so a test can make a
 * tailnet call against a server whose `YAAC_ALLOWED_HOSTS` it stubs to
 * admit that name. Without `login`, what serve sends for a tagged device or
 * Funnel: forwarded, with no user.
 */
export function asTailnet(login: string | null, host: string): Record<string, string> {
  return {
    host,
    'x-forwarded-for': '100.64.0.7',
    ...(login === null ? {} : { 'tailscale-user-login': login, 'tailscale-user-name': login.split('@')[0] }),
  }
}

/**
 * Record a project whose checkout the test has staged in the data dir
 * (`<projects>/<slug>/repo`) — the server's `project add` minus the clone,
 * which a test server has no network for.
 */
export async function registerTestProject(
  server: SpawnedServer,
  slug: string,
  remoteUrl: string,
): Promise<void> {
  const res = await makeServerApiClient(server).project.register.$post({ json: { slug, remoteUrl } })
  if (!res.ok) throw new Error(`registering project ${slug} failed: ${await res.text()}`)
}

/**
 * Give a project a git credential the way the webapp's Settings does: store
 * an HTTPS token under a name, then assign it. Throws on any non-2xx, since
 * a fixture that silently lacks a credential fails far from here.
 */
export async function assignTestGitCredential(
  server: SpawnedServer,
  slug: string,
  token: string,
): Promise<void> {
  const client = makeServerApiClient(server)
  const created = await client.auth.git.credentials.$post({ json: { name: `${slug} token`, token } })
  if (!created.ok) throw new Error(`creating the git credential failed: ${await created.text()}`)
  const { id } = await created.json()
  const assigned = await client.project[':slug']['git-credential'].$put({
    param: { slug }, json: { credentialId: id },
  })
  if (!assigned.ok) throw new Error(`assigning the git credential failed: ${await assigned.text()}`)
}
