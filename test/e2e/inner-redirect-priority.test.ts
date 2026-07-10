import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { requireCluster, IS_NESTED_YAAC } from '@yaac/test-utils/setup'
import { k8sNamespace, kubectlApply, kubectlGetJson, kubectlWithRetry } from '@yaac/server/lib/k8s/kubectl'
import { SESSION_REDIRECT_PRIORITY, VCLUSTER_FALLBACK_PRIORITY } from '@yaac/server/lib/k8s/bootstrap'

// A dedicated, policy-free namespace: the install namespace carries yaac's
// egress world-deny (a Cilium *deny*, which overrides our redirect *allow*),
// so a pure datapath priority test must run somewhere clean — like the spike.
const NS = `${k8sNamespace()}-prio`

/**
 * MANDATORY guard for the undocumented Cilium `toPorts.listener.priority`
 * behavior the nesting design leans on: an inner redirect at the NORMAL
 * session priority must beat the outer vcluster-fallback redirect (a lower
 * precedence) for the SAME pod. "Lower number wins", explicit-vs-explicit.
 *
 * Re-run on every Cilium upgrade; if it breaks, treat it as a release blocker
 * (the yaac-in-yaac inner override would silently stop overriding). Mirrors the
 * 2026-06-16 spike but with the real priority constants, so changing them keeps
 * the test honest. Plain HTTP (port 80) + STATIC echo upstreams isolate the
 * priority resolution (independent of EDS/PP2; the builders are unit-tested).
 */

const CEC = 'prio-cec'
const L_OUTER = 'prio-louter'
const L_INNER = 'prio-linner'
const CNP_OUTER = 'prio-redirect-outer'
const CNP_INNER = 'prio-redirect-inner'
const FAKE = '192.0.2.1' // TEST-NET: only the redirect can make :80 resolve

async function podIp(name: string): Promise<string> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const pod = await kubectlGetJson<{ status?: { phase?: string; podIP?: string } }>([
      'get', 'pod', name, '-n', NS,
    ])
    if (pod?.status?.phase === 'Running' && pod.status.podIP) return pod.status.podIP
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`pod ${name} never became Running with an IP`)
}

function echoPod(name: string, body: string): Record<string, unknown> {
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace: NS, labels: { 'yaac.test': 'true' } },
    spec: {
      containers: [{
        name: 'e', image: 'busybox:1.36',
        command: ['sh', '-c', `mkdir -p /www; echo ${body} > /www/index.html; httpd -f -p 80 -h /www`],
      }],
    },
  }
}

function tcpProxyListener(name: string, cluster: string): Record<string, unknown> {
  return {
    '@type': 'type.googleapis.com/envoy.config.listener.v3.Listener',
    name,
    filterChains: [{ filters: [{
      name: 'envoy.filters.network.tcp_proxy',
      typedConfig: {
        '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
        statPrefix: name, cluster,
      },
    }] }],
  }
}

function staticCluster(name: string, ip: string): Record<string, unknown> {
  return {
    '@type': 'type.googleapis.com/envoy.config.cluster.v3.Cluster',
    name, connectTimeout: '5s', type: 'STATIC',
    loadAssignment: {
      clusterName: name,
      endpoints: [{ lbEndpoints: [{ endpoint: { address: { socketAddress: { address: ip, portValue: 80 } } } }] }],
    },
  }
}

/** A redirect CNP selecting the client, sending :80 to a CEC listener at `priority`. */
function redirectCnp(name: string, listener: string, priority: number): Record<string, unknown> {
  return {
    apiVersion: 'cilium.io/v2', kind: 'CiliumNetworkPolicy',
    metadata: { name, namespace: NS },
    spec: {
      endpointSelector: { matchLabels: { 'prio.client': 'true' } },
      egress: [{
        toEntities: ['world'],
        toPorts: [{
          ports: [{ port: '80', protocol: 'TCP' }],
          listener: { envoyConfig: { kind: 'CiliumEnvoyConfig', name: CEC }, name: listener, priority },
        }],
      }],
    },
  }
}

async function curlClient(): Promise<string> {
  const { stdout } = await kubectlWithRetry([
    'exec', '-n', NS, 'prio-client', '--',
    'wget', '-qO-', '--timeout=8', `http://${FAKE}/`,
  ], { maxAttempts: 1 })
  return stdout.trim()
}

/** Poll the redirect until it routes to `want` (Envoy/policy converge async). */
async function curlUntil(want: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await curlClient().catch(() => '')
    if (last === want) return last
    await new Promise((r) => setTimeout(r, 2000))
  }
  return last
}

// The inner Cilium egress redirect is enforced host-side for a nested
// session, so this priority-override guard isn't observable from in here.
describe.skipIf(IS_NESTED_YAAC)('inner-redirect priority override (the undocumented Cilium guard)', () => {
  beforeAll(async () => {
    await requireCluster()
    // Fresh, policy-free namespace (delete any leftover first, then create).
    await kubectlWithRetry(['delete', 'namespace', NS, '--ignore-not-found', '--wait=true']).catch(() => {})
    await kubectlApply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } })

    await kubectlApply(echoPod('prio-echo-outer', 'OUTER'))
    await kubectlApply(echoPod('prio-echo-inner', 'INNER'))
    await kubectlApply({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: 'prio-client', namespace: NS, labels: { 'yaac.test': 'true', 'prio.client': 'true' } },
      spec: { containers: [{ name: 'c', image: 'busybox:1.36', command: ['sh', '-c', 'sleep 3600'] }] },
    })
    const outerIp = await podIp('prio-echo-outer')
    const innerIp = await podIp('prio-echo-inner')
    await podIp('prio-client')

    await kubectlApply({
      apiVersion: 'cilium.io/v2', kind: 'CiliumEnvoyConfig',
      metadata: {
        name: CEC, namespace: NS,
        annotations: { 'cec.cilium.io/use-original-source-address': 'false' },
      },
      spec: {
        resources: [
          tcpProxyListener(L_OUTER, 'prio-couter'),
          tcpProxyListener(L_INNER, 'prio-cinner'),
          staticCluster('prio-couter', outerIp),
          staticCluster('prio-cinner', innerIp),
        ],
      },
    })
    // Baseline: only the fallback redirect (the low-precedence outer layer).
    await kubectlApply(redirectCnp(CNP_OUTER, L_OUTER, VCLUSTER_FALLBACK_PRIORITY))
  }, 240_000)

  afterAll(async () => {
    // One delete tears down the CEC, CNPs, and pods.
    await kubectlWithRetry(['delete', 'namespace', NS, '--ignore-not-found', '--wait=false']).catch(() => {})
  })

  it('routes to the OUTER (fallback) redirect when it is the only one', async () => {
    expect(await curlUntil('OUTER')).toBe('OUTER')
  })

  it('the inner override at the normal priority BEATS the fallback (lower number wins)', async () => {
    expect(VCLUSTER_FALLBACK_PRIORITY).toBeGreaterThan(SESSION_REDIRECT_PRIORITY)
    await kubectlApply(redirectCnp(CNP_INNER, L_INNER, SESSION_REDIRECT_PRIORITY))
    expect(await curlUntil('INNER')).toBe('INNER')
  })

  it('reverts to the OUTER fallback when the inner override is removed', async () => {
    await kubectlWithRetry(['delete', 'cnp', CNP_INNER, '-n', NS, '--ignore-not-found'])
    expect(await curlUntil('OUTER')).toBe('OUTER')
  })
})
