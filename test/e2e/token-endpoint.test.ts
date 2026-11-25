import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createYaacTestEnv, spawnYaacServer, type YaacTestEnv } from '#support/cli'
import { makeServerApiClient, type SpawnedServer } from '@yaac/test-utils/api'
import { freeLocalPort } from '@yaac/test-utils/kubectl-forward'
import { kubectl } from '@yaac/test-utils/kubectl'
import { applyObject, deleteObject, k8sNamespace, listObjects } from '@yaac/server/drivers/k8s/substrate/api'
import { SERVER_APP_NAME, SERVER_POD_PORT, SERVER_TOKEN_PORT, SERVER_TOKEN_SERVICE_NAME } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { mirrorRef } from '@yaac/server/drivers/k8s/cluster'
import { GVISOR_INSTALLER_MIRROR_TAG } from '@yaac/server/drivers/k8s/install/gvisor-installer'
import { buildTokenServiceManifest, readTokenTlsSecret } from '@yaac/server/drivers/k8s/install/token-endpoint'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/install'
import { env as yaacEnv } from '@yaac/shared/env'
import { tokenKeyFingerprint } from '@yaac/shared/token-tls'

const execFileAsync = promisify(execFile)

/**
 * The token endpoint's datapaths on a cluster (docs/server-in-cluster.md
 * "The token endpoint"), against one test server deployed with the token
 * Service, policy, Secret and mount that install renders:
 *
 *  - kind's: the NodePort Service and the forwarder container beside the
 *    node, run by the function install calls, publishing a free loopback
 *    port. A PAT's `/whoami` from the host goes through it.
 *  - byo's: the same Service re-applied in its `externalIPs` shape at the
 *    kind node's InternalIP, called from inside the node.
 *  - the wall: a pod in another namespace, which no egress policy holds
 *    back, dials the server pod; the token port answers and the API port
 *    does not, so the any-source rule opened one port.
 *
 * Every call pins the generated key, as a caller would. The byo Service
 * and the probe namespace are removed after the file, since the rigs are
 * shared.
 */
describe('the token endpoint on a cluster', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer
  let kindPort: number
  let token: string
  let pin: string
  const probeNs = `${k8sNamespace()}-token-probe`
  const node = `${yaacEnv.kindCluster}-control-plane`

  beforeAll(async () => {
    ensureRootfulPodmanHost()
    testEnv = await createYaacTestEnv()
    kindPort = await freeLocalPort()
    server = await spawnYaacServer(testEnv.env, { token: { listen: { address: '127.0.0.1', port: kindPort }, byo: false } })
    const created = await makeServerApiClient(server).token.$post({ json: { kind: 'pat', label: 'e2e', permissionMode: 'plan' } })
    token = (await created.json()).token ?? ''
    pin = tokenKeyFingerprint((await readTokenTlsSecret()).cert ?? '')
  })

  afterAll(async () => {
    await kubectl(['delete', 'namespace', probeNs, '--ignore-not-found', '--wait=false'], { timeout: 60_000 }).catch(() => undefined)
    await server.stop()
    await testEnv.cleanup()
  })

  /** curl's status line for `url`, pinning the key, from the host or (with
   *  `inNode`) from inside the kind node. */
  async function curl(url: string, opts: { token?: string; inNode?: boolean } = {}): Promise<string> {
    const args = [
      '-sk', '--max-time', '10', '--pinnedpubkey', pin, '-o', '/dev/null', '-w', '%{http_code}',
      ...(opts.token !== undefined ? ['-H', `Authorization: Bearer ${opts.token}`] : []), url,
    ]
    const { stdout } = opts.inNode === true
      ? await execFileAsync('podman', ['exec', node, 'curl', ...args], { timeout: 30_000 })
      : await execFileAsync('curl', args, { timeout: 30_000 })
    return stdout.trim()
  }

  it('kind\'s: a token\'s call reaches the server from the host through the forwarder, and nothing else does', async () => {
    const origin = `https://127.0.0.1:${String(kindPort)}`
    // The forwarder's Envoy takes a moment to listen after its start.
    await expect.poll(() => curl(`${origin}/api/whoami`, { token }), { timeout: 30_000, interval: 1_000 }).toBe('200')
    expect(await curl(`${origin}/api/whoami`)).toBe('401')
    expect(await curl(`${origin}/api/token`, { token })).toBe('403')
  })

  it('byo\'s: an externalIPs Service delivers the node\'s address and port to the server', async () => {
    const { stdout: nodeIp } = await kubectl([
      'get', 'node', node, '-o', 'jsonpath={.status.addresses[?(@.type=="InternalIP")].address}',
    ], { timeout: 30_000 })
    // The API server checks external addresses for no clash, so pick a port
    // no Service names.
    const named = new Set((await listObjects<{ spec?: { ports?: Array<{ port?: number }> } }>('v1', 'Service'))
      .flatMap((s) => (s.spec?.ports ?? []).map((p) => p.port)))
    let port = 20000
    while (named.has(port)) port += 1
    await deleteObject({ apiVersion: 'v1', kind: 'Service', name: SERVER_TOKEN_SERVICE_NAME, namespace: k8sNamespace() }, { wait: true })
    await applyObject(buildTokenServiceManifest({ address: nodeIp.trim(), port }, true))
    const url = `https://${nodeIp.trim()}:${String(port)}/api/whoami`
    await expect.poll(() => curl(url, { token, inNode: true }), { timeout: 60_000, interval: 2_000 }).toBe('200')
  })

  it('the wall: the token port admits any pod, and the API port still does not', async () => {
    const { stdout: podIp } = await kubectl([
      'get', 'pod', '-n', k8sNamespace(), '-l', `app=${SERVER_APP_NAME}`, '-o', 'jsonpath={.items[0].status.podIP}',
    ], { timeout: 30_000 })
    await kubectl(['create', 'namespace', probeNs], { timeout: 30_000 })
    const script = [
      `token=$(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' https://${podIp.trim()}:${String(SERVER_TOKEN_PORT)}/api/health)`,
      `api=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://${podIp.trim()}:${String(SERVER_POD_PORT)}/api/health; echo " exit $?")`,
      'echo "token=$token api=$api"',
    ].join('; ')
    await applyObject({
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'token-wall', namespace: probeNs },
      spec: {
        restartPolicy: 'Never',
        containers: [{ name: 'probe', image: await mirrorRef('curl', GVISOR_INSTALLER_MIRROR_TAG), command: ['sh', '-c', script] }],
      },
    })
    await kubectl(['wait', 'pod', 'token-wall', '-n', probeNs, '--for=jsonpath={.status.phase}=Succeeded', '--timeout=120s'], { timeout: 130_000 })
    const { stdout } = await kubectl(['logs', 'token-wall', '-n', probeNs], { timeout: 30_000 })
    expect(stdout).toMatch(/token=401 /)
    expect(stdout).toMatch(/api=000 exit 28/)
  })
})
