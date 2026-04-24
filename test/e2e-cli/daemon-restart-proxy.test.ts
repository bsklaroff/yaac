import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import {
  createYaacTestEnv,
  runYaac,
  acquireDaemonMutex,
  type YaacTestEnv,
} from '@test/helpers/cli'
import { readLock } from '@/shared/lock'
import { requirePodman, podmanRetry } from '@test/helpers/setup'
import { podman, createAndStartContainerWithRetry } from '@/lib/container/runtime'

/**
 * Regression test for the daemon-restart network-loss bug: restarting the
 * daemon while its proxy sidecar is running must not force-remove or
 * recreate the proxy — session containers hold the proxy's internal-network
 * IP in their HTTPS_PROXY env vars and lose network access if the proxy
 * comes back on a new IP.
 *
 * Uses the real `yaac daemon restart` command (not spawnYaacDaemon) so the
 * stop/start race matches production: stopDaemon waits only for the lock
 * to be removed, then startDaemon spawns the new daemon immediately — the
 * outgoing daemon may still be mid-shutdown when the new one's background
 * loop fires its first tick.
 */

// Hold the cross-worker mutex for the whole file since we spawn detached
// daemons via `yaac daemon start` / `daemon restart` (not spawnYaacDaemon,
// which owns its own mutex). Serializes us with any other daemon-using
// test across parallel vitest workers.
let releaseDaemonMutex: (() => Promise<void>) | null = null
beforeAll(async () => {
  await requirePodman()
  releaseDaemonMutex = await acquireDaemonMutex()
})
afterAll(async () => {
  await releaseDaemonMutex?.()
  releaseDaemonMutex = null
})

describe('daemon restart preserves running proxy (real `yaac daemon restart`)', () => {
  const network = `yaac-test-restart-${crypto.randomBytes(4).toString('hex')}`
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await killDaemonByLock()
    try {
      const { stdout } = await podmanRetry([
        'ps', '-a', '--filter', `network=${network}`, '--format', '{{.Names}}',
      ])
      const names = stdout.split('\n').filter(Boolean)
      if (names.length > 0) await podmanRetry(['rm', '-f', ...names])
    } catch { /* ok */ }
    try { await podmanRetry(['network', 'rm', network]) } catch { /* ok */ }
    await testEnv.cleanup()
  })

  it('`yaac daemon restart` preserves proxy identity, IP, and session reachability', async () => {
    const daemonEnv = { ...testEnv.env, YAAC_PROXY_NETWORK: network }

    // Real `yaac daemon start` — spawns a detached daemon subprocess.
    const started = await runYaac(daemonEnv, 'daemon', 'start')
    expect(started.exitCode).toBe(0)

    // Wait for the background loop's first tick to bring the proxy up.
    const proxyBefore = await waitForRunningProxy(network, 30_000)
    const idBefore = proxyBefore.Id
    const startedAtBefore = proxyBefore.State.StartedAt
    const ipBefore = ipOnNetwork(proxyBefore, network)
    expect(ipBefore).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    const proxyName = proxyBefore.Name.replace(/^\//, '')

    // Attach a session-like container to the proxy network, labeled as
    // if it were a real yaac session. This matches the production shape:
    //   - a container on the proxy's internal network
    //   - a `yaac.proxy-container=<name>` label (gcStaleProxies uses it)
    //   - a `yaac.data-dir=<dir>` label (reconcile/prewarm/forwarders use it)
    // Without this, the daemon's restart-time queries see zero session
    // containers and may behave differently than in prod.
    const { stdout: baseImages } = await podmanRetry([
      'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
    ])
    const baseImage = baseImages.trim().split('\n')[0]
    expect(baseImage).toBeTruthy()

    const sessionName = `yaac-restart-test-sess-${crypto.randomBytes(4).toString('hex')}`
    await createAndStartContainerWithRetry({
      Image: baseImage,
      name: sessionName,
      Labels: {
        'yaac.test': 'true',
        // Keep `yaac.proxy-container` so gcStaleProxies sees a dependent
        // session and preserves the proxy. Deliberately omit the session
        // labels (`yaac.data-dir`, `yaac.session-id`, `yaac.project`) so
        // reconcileStaleSessions — which tmux-pings and reaps anything
        // without a live tmux — doesn't eat this test probe.
        'yaac.proxy-container': proxyName,
      },
      // No Cmd override — the base image's ENTRYPOINT is
      // `catatonit -- sleep infinity`, which keeps the container alive.
      HostConfig: { NetworkMode: network },
    })

    // Baseline: the session container can reach the proxy on the
    // internal network at the IP the real HTTPS_PROXY env var would use.
    await expectReachable(sessionName, ipBefore!)

    const lockBefore = await readLock()
    expect(lockBefore).not.toBeNull()

    // Exercise the real restart command. This is the exact sequence users
    // hit: stopDaemon SIGTERMs + waits only for the lock file to be
    // removed, then startDaemon spawns the new daemon immediately.
    const restarted = await runYaac(daemonEnv, 'daemon', 'restart')
    expect(restarted.exitCode).toBe(0)

    const lockAfter = await readLock()
    expect(lockAfter).not.toBeNull()
    expect(lockAfter!.pid).not.toBe(lockBefore!.pid)

    // Give the new daemon's first background-loop tick time to call
    // persistAllBlockedHosts -> proxyClient.ensureRunning(). The tick
    // runs immediately on startup; 8s is well past the inline path.
    await new Promise((r) => setTimeout(r, 8_000))

    const proxyAfter = await podman.getContainer(proxyName).inspect()
    expect(proxyAfter.State.Running).toBe(true)
    // Identity preserved — not force-removed then recreated.
    expect(proxyAfter.Id).toBe(idBefore)
    expect(proxyAfter.State.StartedAt).toBe(startedAtBefore)
    // Internal-network IP preserved — existing session containers'
    // HTTPS_PROXY env vars depend on this.
    expect(ipOnNetwork(proxyAfter, network)).toBe(ipBefore)

    // The bug's actual symptom: the session container must still be able
    // to reach the proxy at its original IP.
    await expectReachable(sessionName, ipBefore!)
  }, 180_000)

  it('restart with a second stale-hash proxy and dependent session — both proxies survive', async () => {
    const daemonEnv = { ...testEnv.env, YAAC_PROXY_NETWORK: network }

    const started = await runYaac(daemonEnv, 'daemon', 'start')
    expect(started.exitCode).toBe(0)

    const currentProxy = await waitForRunningProxy(network, 30_000)
    const currentProxyName = currentProxy.Name.replace(/^\//, '')
    const currentId = currentProxy.Id
    const currentStartedAt = currentProxy.State.StartedAt
    const currentIp = ipOnNetwork(currentProxy, network)!

    // Stand up a second container labeled like a proxy from a previous yaac
    // version (different image-hash). Simulates the post-upgrade state
    // where an old proxy is still running because sessions depend on it.
    // We use the test-base image for simplicity — we're not asserting on
    // its HTTPS handling, only on whether the daemon's gcStaleProxies
    // preserves it.
    const { stdout: baseImages } = await podmanRetry([
      'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
    ])
    const baseImage = baseImages.trim().split('\n')[0]
    expect(baseImage).toBeTruthy()

    const staleProxyName = `yaac-proxy-stalehash-${crypto.randomBytes(4).toString('hex')}`
    await createAndStartContainerWithRetry({
      Image: baseImage,
      name: staleProxyName,
      Labels: {
        'yaac.test': 'true',
        'yaac.proxy': 'true',
        'yaac.proxy.image-hash': 'fake-old-hash-aaaaaaaa',
      },
      HostConfig: { NetworkMode: network },
    })
    const staleProxyInspect = await podman.getContainer(staleProxyName).inspect()
    const staleProxyId = staleProxyInspect.Id
    const staleProxyStartedAt = staleProxyInspect.State.StartedAt

    // A session container that depends on the stale proxy (the condition
    // that should make gcStaleProxies preserve it).
    const staleDependentName = `yaac-restart-test-olddep-${crypto.randomBytes(4).toString('hex')}`
    await createAndStartContainerWithRetry({
      Image: baseImage,
      name: staleDependentName,
      Labels: {
        'yaac.test': 'true',
        'yaac.proxy-container': staleProxyName,
      },
      HostConfig: { NetworkMode: network },
    })

    // A session container that depends on the CURRENT proxy.
    const currentDependentName = `yaac-restart-test-newdep-${crypto.randomBytes(4).toString('hex')}`
    await createAndStartContainerWithRetry({
      Image: baseImage,
      name: currentDependentName,
      Labels: {
        'yaac.test': 'true',
        'yaac.proxy-container': currentProxyName,
      },
      HostConfig: { NetworkMode: network },
    })

    // Baseline: current-proxy dependent can reach the current proxy.
    await expectReachable(currentDependentName, currentIp)

    const restarted = await runYaac(daemonEnv, 'daemon', 'restart')
    expect(restarted.exitCode).toBe(0)

    await new Promise((r) => setTimeout(r, 8_000))

    // Both proxies must still be running and unchanged.
    const staleAfter = await podman.getContainer(staleProxyName).inspect()
    expect(staleAfter.State.Running).toBe(true)
    expect(staleAfter.Id).toBe(staleProxyId)
    expect(staleAfter.State.StartedAt).toBe(staleProxyStartedAt)

    const currentAfter = await podman.getContainer(currentProxyName).inspect()
    expect(currentAfter.State.Running).toBe(true)
    expect(currentAfter.Id).toBe(currentId)
    expect(currentAfter.State.StartedAt).toBe(currentStartedAt)
    expect(ipOnNetwork(currentAfter as unknown as PodmanInspectLite, network)).toBe(currentIp)

    // Session depending on the current proxy must still reach it.
    await expectReachable(currentDependentName, currentIp)
  }, 180_000)
})

interface PodmanInspectLite {
  Id: string
  Name: string
  State: { Running: boolean; StartedAt: string }
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> }
}

async function waitForRunningProxy(
  network: string,
  timeoutMs: number,
): Promise<PodmanInspectLite> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { stdout } = await podmanRetry([
      'ps', '--filter', 'label=yaac.proxy=true', '--format', '{{.Names}}',
    ])
    for (const name of stdout.split('\n').filter(Boolean)) {
      const info = await podman.getContainer(name).inspect() as unknown as PodmanInspectLite
      if (info.State.Running && info.NetworkSettings.Networks[network]) {
        return info
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no running proxy on network ${network} within ${timeoutMs}ms`)
}

function ipOnNetwork(info: PodmanInspectLite, network: string): string | undefined {
  return info.NetworkSettings.Networks[network]?.IPAddress
}

async function expectReachable(fromContainer: string, proxyIp: string): Promise<void> {
  // Use the proxy's /healthz endpoint on the internal network — same path
  // a session container's HTTPS_PROXY would tunnel to. We're checking the
  // network reachability, not credentialed forwarding.
  const { stdout } = await podmanRetry([
    'exec', fromContainer, 'sh', '-c',
    `curl -sf --connect-timeout 5 http://${proxyIp}:10255/healthz || echo UNREACHABLE`,
  ], { timeout: 15_000 })
  expect(stdout.trim()).toBe('ok')
}

async function killDaemonByLock(): Promise<void> {
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
