import { createRawApiClient } from '@yaac/shared/api-core'
import type { buildApp } from '@yaac/server/main/server'
import type { SpawnedServer } from '#cli'

type ServerApp = ReturnType<typeof buildApp>

/**
 * Wrap an in-memory `buildApp(...)` as a raw typed API client, dispatching
 * through `app.fetch` with no port bound. The loopback host passes the Host
 * check and identifies the caller as local.
 *
 * Unlike `createApiClient`, it neither throws on non-2xx nor unwraps the
 * body, so tests can assert status codes.
 */
export function makeTestApiClient(app: ServerApp) {
  return createRawApiClient('http://127.0.0.1', (input, init) =>
    Promise.resolve(app.fetch(new Request(input as string | URL, init))))
}

/**
 * Like `makeTestApiClient`, but over HTTP to a spawned server.
 */
export function makeServerApiClient(server: SpawnedServer) {
  return createRawApiClient(`http://127.0.0.1:${server.lock.port}`)
}

/**
 * The headers `tailscale serve` adds when forwarding a request from a
 * user's tailnet device to `host`. With a null `login`, the headers serve
 * sends for a tagged device or Funnel (no user).
 */
export function asTailnet(login: string | null, host: string): Record<string, string> {
  return {
    host,
    'x-forwarded-for': '100.64.0.7',
    ...(login === null ? {} : { 'tailscale-user-login': login, 'tailscale-user-name': login.split('@')[0] }),
  }
}

/**
 * Register a project whose checkout the test staged at
 * `<projects>/<id>/repo`: `project add` without the clone.
 */
export async function registerTestProject(
  server: SpawnedServer,
  id: string,
  name: string,
  remoteUrl: string,
): Promise<void> {
  const res = await makeServerApiClient(server).project.register.$post({ json: { id, name, remoteUrl } })
  if (!res.ok) throw new Error(`registering project ${name} (${id}) failed: ${await res.text()}`)
}

/**
 * Give a project a git credential as the webapp's Settings does: store an
 * HTTPS token under a name, then assign it. Throws on any non-2xx.
 * `project` is anything the routes resolve (a name or an id). Credential
 * names are unique and outlive projects, so a second project with the same
 * name must pass its own `name`.
 */
export async function assignTestGitCredential(
  server: SpawnedServer,
  project: string,
  token: string,
  name = `${project} token`,
): Promise<void> {
  const client = makeServerApiClient(server)
  const created = await client.auth.git.credentials.$post({ json: { name, token } })
  if (!created.ok) throw new Error(`creating the git credential failed: ${await created.text()}`)
  const { id } = await created.json()
  const assigned = await client.project[':projectId']['git-credential'].$put({
    param: { projectId: project }, json: { credentialId: id },
  })
  if (!assigned.ok) throw new Error(`assigning the git credential failed: ${await assigned.text()}`)
}
