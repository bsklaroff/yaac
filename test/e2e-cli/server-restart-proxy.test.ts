import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import {
  createYaacTestEnv,
  runYaac,
  acquireServerMutex,
  type YaacTestEnv,
} from '@yaac/test-utils/cli'
import { readLock } from '@yaac/shared/lock'
import { requirePodman, requireCluster, TEST_PROXY_CONFIG } from '@yaac/test-utils/setup'
import { ProxyClient } from '@yaac/server/features/sessions/egress/proxy-client'
import { PROXY_APP_NAME, PROXY_AUTH_SECRET_NAME } from '@yaac/server/platform/k8s/proxy-constants'
import {
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
} from '@yaac/server/platform/k8s/kubectl'

/**
 * Regression test for server-restart proxy churn: restarting the server
 * while its proxy is running must not tear down or replace the proxy —
 * session pods hold `HTTPS_PROXY=...yaac-proxy.<ns>.svc:10255` env vars,
 * and while the Service DNS name is stable, a proxy pod replacement
 * still drops live MITM tunnels and loses ssh-agent identities.
 *
 * Kubernetes-era expectations (the successor to the podman-era
 * "adoption" semantics):
 *   - the proxy Deployment/Service survive the restart untouched
 *     (`kubectl apply` reconciles; same image hash → no rollout)
 *   - the concrete proxy pod is NOT replaced (same UID)
 *   - the second server reads the auth secret back from the
 *     `yaac-proxy-auth` Secret instead of regenerating it
 *   - a session-like pod can still reach the proxy via the Service after
 *     the restart
 *
 * Uses the real `yaac server restart` command (not spawnYaacServer) so the
 * stop/start race matches production: stopServer waits only for the lock
 * to be removed, then startServer spawns the new server immediately — the
 * outgoing server may still be mid-shutdown when the new one's background
 * loop fires its first tick.
 *
 * Dropped from the podman era (no k8s analog):
 *   - the "second stale-hash proxy + dependent session" case — there is
 *     exactly one proxy Deployment per namespace now; `kubectl apply`
 *     replaces the pod in-place on image-hash changes instead of running
 *     old and new proxies side by side.
 *   - the skipped listContainers-race case — that raced podman's
 *     container store; the apiserver has no equivalent failure mode.
 */

// Hold the cross-worker mutex for the whole file since we spawn detached
// servers via `yaac server start` / `server restart` (not spawnYaacServer,
// which owns its own mutex). Serializes us with any other server-using
// test across parallel vitest workers.
let releaseServerMutex: (() => Promise<void>) | null = null
beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  releaseServerMutex = await acquireServerMutex()
})
afterAll(async () => {
  await releaseServerMutex?.()
  releaseServerMutex = null
})

interface ProxyPodIdentity {
  name: string
  uid: string
  startedAt: string
}

interface RawPodList {
  items: Array<{
    metadata?: { name?: string; uid?: string; deletionTimestamp?: string }
    status?: { phase?: string; startTime?: string }
  }>
}

async function findRunningProxyPod(): Promise<ProxyPodIdentity | null> {
  const list = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', k8sNamespace(), '-l', `app=${PROXY_APP_NAME}`,
  ])
  const pod = list?.items.find(
    (p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp,
  )
  if (!pod) return null
  return {
    name: pod.metadata?.name ?? '',
    uid: pod.metadata?.uid ?? '',
    startedAt: pod.status?.startTime ?? '',
  }
}

async function waitForRunningProxyPod(timeoutMs: number): Promise<ProxyPodIdentity> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pod = await findRunningProxyPod().catch(() => null)
    if (pod) return pod
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no running proxy pod in namespace ${k8sNamespace()} within ${timeoutMs}ms`)
}

async function readProxyAuthSecret(): Promise<string | null> {
  const secret = await kubectlGetJson<{ data?: Record<string, string> }>([
    'get', 'secret', PROXY_AUTH_SECRET_NAME, '-n', k8sNamespace(),
  ])
  const encoded = secret?.data?.secret
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null
}

describe('server restart preserves running proxy (real `yaac server restart`)', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killServerByLock()
    // Remove the proxy Deployment/Service so the next test's server
    // bootstraps from a clean namespace state.
    await kubectlWithRetry([
      'delete', 'deployment,service', PROXY_APP_NAME,
      '-n', k8sNamespace(), '--ignore-not-found', '--wait=false',
    ]).catch(() => { /* best effort */ })
    await testEnv.cleanup()
  })

  it('`yaac server restart` preserves the proxy; a replaced proxy pod self-heals from /data', async () => {
    const serverEnv = testEnv.env

    // Real `yaac server start` — spawns a detached server subprocess.
    const started = await runYaac(serverEnv, 'server', 'start')
    expect(started.exitCode).toBe(0)

    // The server deploys the proxy lazily on the first session create, not
    // on startup — stand the proxy up from the test process (same data dir
    // and namespace) to simulate a server that has created a session.
    //
    // Register a session that has NO backing session pod: nothing in the
    // server re-registers sessions at runtime (the proxy owns its state via
    // the /data write-through), so if this registration survives the proxy
    // pod churn at the end of this test, it can only have come from the
    // proxy's /data reload — the server (old or restarted) cannot have
    // healed a pod-less session itself.
    const client = new ProxyClient(TEST_PROXY_CONFIG)
    await client.ensureRunning()
    const sessionId = crypto.randomUUID()
    await client.registerSession(sessionId, {
      rules: [{
        hostPattern: 'api.example.com',
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'x-key', secretRef: 'MY_KEY' }],
      }],
      allowedHosts: ['github.com'],
      tool: 'claude',
      projectSlug: 'restart-proxy',
    })

    const proxyBefore = await waitForRunningProxyPod(60_000)
    expect(proxyBefore.uid).toBeTruthy()

    const secretBefore = await readProxyAuthSecret()
    expect(secretBefore).toBeTruthy()

    // Baseline: the proxy is up and wired to its Service before the
    // restart, so the post-restart assertion means "still up" rather than
    // "was never checked".
    await expectProxyReachable()

    const lockBefore = await readLock()
    expect(lockBefore).not.toBeNull()

    // Exercise the real restart command. This is the exact sequence users
    // hit: stopServer SIGTERMs + waits only for the lock file to be
    // removed, then startServer spawns the new server immediately.
    const restarted = await runYaac(serverEnv, 'server', 'restart')
    expect(restarted.exitCode).toBe(0)

    const lockAfter = await readLock()
    expect(lockAfter).not.toBeNull()
    expect(lockAfter!.pid).not.toBe(lockBefore!.pid)

    // Give the new server's first background-loop tick time to run its
    // reconcile steps (attach-only — they must not churn the proxy). The
    // tick runs immediately on startup; 8s is well past the inline path.
    await new Promise((r) => setTimeout(r, 8_000))

    // The Deployment must still be there and the SAME pod must still be
    // running — `kubectl apply` with an unchanged template must not have
    // triggered a rollout, and nothing may have force-deleted the pod.
    const proxyAfter = await findRunningProxyPod()
    expect(proxyAfter).not.toBeNull()
    expect(proxyAfter!.uid).toBe(proxyBefore.uid)
    expect(proxyAfter!.name).toBe(proxyBefore.name)
    expect(proxyAfter!.startedAt).toBe(proxyBefore.startedAt)

    // The second server must have read the existing auth secret back from
    // the k8s Secret rather than rotating it — a rotation would strand
    // the proxy pod's env-injected copy until the next pod replacement.
    const secretAfter = await readProxyAuthSecret()
    expect(secretAfter).toBe(secretBefore)

    // The bug's actual symptom: the proxy must still be serving at its
    // Service address after the restart, not torn down or left unwired.
    await expectProxyReachable()

    // Phase 2 — proxy pod replacement. The restart above already proved
    // the registration survives a server hand-off (the phantom session is
    // still in the proxy); now churn the proxy pod itself and prove the
    // replacement reloads it from /data.
    // Kill the proxy pod; the Deployment replaces it.
    await kubectlWithRetry([
      'delete', 'pod', '-n', k8sNamespace(), '-l', `app=${PROXY_APP_NAME}`,
      '--wait=false', '--grace-period=1',
    ])
    const deadline = Date.now() + 120_000
    let proxyReplaced = await findRunningProxyPod().catch(() => null)
    while (Date.now() < deadline && (!proxyReplaced || proxyReplaced.uid === proxyBefore.uid)) {
      await new Promise((r) => setTimeout(r, 1000))
      proxyReplaced = await findRunningProxyPod().catch(() => null)
    }
    expect(proxyReplaced).not.toBeNull()
    expect(proxyReplaced!.uid).not.toBe(proxyBefore.uid)

    // Re-attach through a fresh tunnel (the old one died with the pod)
    // and confirm the replacement reloaded the registration from /data —
    // with the server running the whole time and unable to have healed
    // this pod-less session itself.
    const reattachDeadline = Date.now() + 30_000
    let attached = false
    while (Date.now() < reattachDeadline && !attached) {
      attached = await client.attachIfRunning()
      if (!attached) await new Promise((r) => setTimeout(r, 500))
    }
    expect(attached).toBe(true)
    expect(await client.listSessions()).toContain(sessionId)

    await client.removeSession(sessionId)
    client.disconnect()
  }, 300_000)
})

/**
 * Assert the proxy is up and correctly wired to its Service.
 *
 * Deliberately NOT probed from a pod. The proxy's control port is
 * node-only by policy — the server registers sessions over it and the
 * kubelet probes it, and no workload may reach it (see
 * buildProxyIngressNpManifest). So this checks the two things a legal
 * client can observe, which together cover the bug this test exists for:
 *
 *  - the Deployment reports a ready replica, which means kubelet's own
 *    /healthz probe succeeded FROM THE NODE — the app is serving, not
 *    merely scheduled; and
 *  - the Service has a ready endpoint, so the address session pods are
 *    pointed at actually resolves to that pod (a Ready pod behind a
 *    broken selector would otherwise pass).
 */
async function expectProxyReachable(): Promise<void> {
  interface RawDeploy { status?: { readyReplicas?: number } }
  interface RawSlices {
    items?: Array<{ endpoints?: Array<{ addresses?: string[]; conditions?: { ready?: boolean } }> }>
  }
  const deadline = Date.now() + 60_000
  let ready = 0
  let endpoints: string[] = []
  for (;;) {
    const dep = await kubectlGetJson<RawDeploy>([
      'get', 'deployment', PROXY_APP_NAME, '-n', k8sNamespace(),
    ]).catch(() => null)
    ready = dep?.status?.readyReplicas ?? 0
    const slices = await kubectlGetJson<RawSlices>([
      'get', 'endpointslice', '-n', k8sNamespace(),
      '-l', `kubernetes.io/service-name=${PROXY_APP_NAME}`,
    ]).catch(() => null)
    endpoints = (slices?.items ?? [])
      .flatMap((s) => s.endpoints ?? [])
      .filter((e) => e.conditions?.ready !== false)
      .flatMap((e) => e.addresses ?? [])
    if (ready >= 1 && endpoints.length > 0) return
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  expect(ready, 'proxy Deployment has no ready replica').toBeGreaterThanOrEqual(1)
  expect(endpoints, 'proxy Service has no ready endpoint').not.toHaveLength(0)
}

async function killServerByLock(): Promise<void> {
  const lock = await readLock()
  if (!lock) return
  try { process.kill(lock.pid, 'SIGTERM') } catch { /* already gone */ }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const cur = await readLock()
    if (!cur || cur.pid !== lock.pid) return
    await new Promise((r) => setTimeout(r, 50))
  }
}
