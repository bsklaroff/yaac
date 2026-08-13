import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import {
  requirePodman,
  requireCluster,
  useTestNamespace,
  createTempDataDir,
  cleanupTempDir,
  TEST_PROXY_CONFIG,
  IS_NESTED_YAAC,
} from '@yaac/test-utils/setup'
import { resolveTestBaseImageRef } from '@yaac/test-utils/mock-remotes'
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import { proxyServiceClusterIp } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { NETD_APP_NAME } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { REDIRECT_CLAIMS_CM_NAME } from '@yaac/server/drivers/k8s/cluster/redirect-claims'
import { runtimeClassSpec } from '@yaac/server/drivers/k8s/substrate/gvisor'
import { CA_CONFIGMAP_NAME } from '@yaac/server/drivers/k8s/substrate/pod-spec'
import { worktreeIdLabels } from '@yaac/server/drivers/k8s/substrate/pods'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@yaac/server/drivers/k8s/substrate/kubectl'

/**
 * Datapath-level gates for the netd redirect — the properties that make
 * the egress model SAFE rather than merely working. The behavioural
 * "traffic reaches the right place" coverage lives in
 * transparent-egress.test.ts; everything here is about what happens when
 * the redirect is absent, late, or attacked.
 *
 * All of it asserts on the node's real dataplane, so the whole file is
 * gated on a host run: inside a nested yaac the session's redirect is
 * programmed by the OUTER netd on a node this vcluster cannot see.
 */

let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  tempDataDir = await createTempDataDir()
})

afterAll(async () => {
  restoreNamespace?.()
  restoreNamespace = null
  if (tempDataDir) await cleanupTempDir(tempDataDir)
  tempDataDir = null
})

/** A never-routable TEST-NET-1 address: reaching it proves interception. */
const FAKE_IP = '192.0.2.20'
const MITM_HOST = 'api.anthropic.com'
const CA_PATH = '/etc/yaac/certs/proxy-ca.pem'

async function deleteTestPod(name: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'pod', name, '-n', k8sNamespace(),
    '--ignore-not-found', '--wait=false', '--grace-period=1',
  ]).catch(() => { /* ok */ })
}

async function waitForPodRunning(name: string, timeoutMs = 120_000): Promise<void> {
  interface RawPod { status?: { phase?: string } }
  const deadline = Date.now() + timeoutMs
  let phase = 'Pending'
  while (Date.now() < deadline) {
    const pod = await kubectlGetJson<RawPod>(['get', 'pod', name, '-n', k8sNamespace()])
    phase = pod?.status?.phase ?? 'Unknown'
    if (phase === 'Running') {
      // The pod that just came up is the one the following assertions are
      // about, so its node is the one whose netd they must read.
      await focusNetdOnPod(name)
      return
    }
    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new Error(`pod ${name} reached terminal phase ${phase}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`pod ${name} not Running within ${timeoutMs}ms (phase ${phase})`)
}

async function startWorktreePod(
  name: string,
  worktreeId: string,
  proxyHost: string,
  opts: { netRaw?: boolean } = {},
): Promise<void> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: { ...worktreeIdLabels(worktreeId), 'yaac.test': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...runtimeClassSpec({ inner: IS_NESTED_YAAC, nested: opts.netRaw }),
      dnsPolicy: 'None',
      dnsConfig: { nameservers: [proxyHost] },
      containers: [{
        name: 'session',
        image: await resolveTestBaseImageRef(),
        imagePullPolicy: 'IfNotPresent',
        ...(opts.netRaw
          ? { securityContext: { capabilities: { add: ['NET_RAW', 'NET_ADMIN'] } } }
          : {}),
        volumeMounts: [{ name: 'proxy-ca', mountPath: '/etc/yaac/certs', readOnly: true }],
      }],
      volumes: [{ name: 'proxy-ca', configMap: { name: CA_CONFIGMAP_NAME } }],
    },
  })
}

/**
 * The node whose netd the probes below should read.
 *
 * netd is a DaemonSet and each instance programs ONLY the pods on its own
 * node — a pod elsewhere is deliberately "emit nothing". So "the netd" is
 * meaningless once the cluster has more than one node: reading an
 * arbitrary instance yields an empty chain and reports as netd having
 * failed to render. Every probe therefore has to name the node it means,
 * which is the node hosting the pod under test.
 *
 * Null until a pod is up (netd's own startup/restart gates ask about the
 * DaemonSet, not about any pod), and single-node clusters never notice
 * either way because there is only one instance to resolve.
 */
let netdTargetNode: string | null = null

/** Point the netd probes at the node hosting `pod`. */
async function focusNetdOnPod(name: string, namespace = k8sNamespace()): Promise<void> {
  interface RawPod { spec?: { nodeName?: string } }
  const pod = await kubectlGetJson<RawPod>(['get', 'pod', name, '-n', namespace])
    .catch(() => null)
  netdTargetNode = pod?.spec?.nodeName ?? netdTargetNode
}

/**
 * A LIVE netd pod for this install, on the node the probes are focused on.
 *
 * Deliberately not `ds/yaac-netd`: kubectl resolves a DaemonSet to
 * whichever of its pods it lists first, and a terminating pod is still
 * `phase: Running` — so it gets picked and the command then dies with
 * `pods "..." not found`. The netd-restart test leaves exactly that state
 * behind for whatever runs next, which made every later probe flaky.
 * Resolving per call, and skipping anything with a deletionTimestamp,
 * removes the race.
 */
async function netdPodName(timeoutMs = 120_000): Promise<string> {
  interface RawPodList {
    items?: Array<{
      metadata?: { name?: string; deletionTimestamp?: string }
      spec?: { nodeName?: string }
      status?: { conditions?: Array<{ type?: string; status?: string }> }
    }>
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const list = await kubectlGetJson<RawPodList>([
      'get', 'pods', '-n', k8sNamespace(), '-l', `app=${NETD_APP_NAME}`,
      '--field-selector=status.phase=Running',
    ])
    const name = (list?.items ?? []).find((pod) =>
      !pod.metadata?.deletionTimestamp
      && (netdTargetNode === null || pod.spec?.nodeName === netdTargetNode)
      // READY, not merely Running: netd's readiness marker is written only
      // after a reconcile reaches the dataplane, so a Ready pod is one whose
      // chain is programmed and whose startup line is logged. A pod can be
      // `phase: Running` with only its Envoy container up, which is how a
      // probe ends up reading an empty log or an empty chain.
      && (pod.status?.conditions ?? [])
        .some((c) => c.type === 'Ready' && c.status === 'True'),
    )?.metadata?.name
    if (name) return name
    if (Date.now() >= deadline) {
      throw new Error('no ready netd pod within timeout'
        + (netdTargetNode ? ` on node ${netdTargetNode}` : ''))
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Why the last netdLogs() read came back empty — for timeout messages. */
let lastNetdLogsError = 'never attempted'

/** The `netd` container's logs from a ready pod; '' if it vanished mid-read. */
async function netdLogs(): Promise<string> {
  try {
    const { stdout } = await kubectlWithRetry([
      'logs', await netdPodName(), '-c', 'netd', '-n', k8sNamespace(),
    ], { timeout: 60_000 })
    return stdout
  } catch (err) {
    // Replaced between resolving it and reading it; callers poll. Keep the
    // reason: an empty read here otherwise reports as a bare timeout, and
    // "no READY netd pod" and "logs unreadable" want very different triage.
    lastNetdLogsError = err instanceof Error ? err.message : String(err)
    return ''
  }
}

/** DaemonSet + pod state, for a timeout that needs to explain itself. */
async function netdDiagnostics(): Promise<string> {
  interface RawPodList {
    items?: Array<{
      metadata?: { name?: string; deletionTimestamp?: string }
      status?: {
        phase?: string
        conditions?: Array<{ type?: string; status?: string; message?: string }>
        containerStatuses?: Array<{ name?: string; ready?: boolean; restartCount?: number
          state?: Record<string, unknown> }>
      }
    }>
  }
  const list = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', k8sNamespace(), '-l', `app=${NETD_APP_NAME}`,
  ]).catch(() => null)
  return JSON.stringify((list?.items ?? []).map((pod) => ({
    name: pod.metadata?.name,
    deleting: !!pod.metadata?.deletionTimestamp,
    phase: pod.status?.phase,
    ready: (pod.status?.conditions ?? []).find((c) => c.type === 'Ready')?.status,
    containers: (pod.status?.containerStatuses ?? []).map((c) => ({
      name: c.name, ready: c.ready, restarts: c.restartCount, state: c.state,
    })),
  })))
}

/** Run a command in a ready netd pod's `netd` container. */
async function netdExec(args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await kubectlWithRetry([
        'exec', '-n', k8sNamespace(), await netdPodName(), '-c', 'netd', '--', ...args,
      ], { timeout: 60_000 })
      return stdout
    } catch (err) {
      // Same race as above: the pod can be replaced between resolving it
      // and exec'ing into it. Re-resolve and retry a bounded number of times.
      if (attempt >= 2) throw err
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/**
 * THIS install's redirect chain, read from its own netd's startup line.
 *
 * Deliberately not discovered from `nat PREROUTING`: several installs
 * share the node (the real one plus this run's), each with its own
 * appended `YAAC_RDR_*` jump, so picking a jump out of that chain is
 * ambiguous — and picking the wrong one silently inspects another
 * install's rules. netd logs the chain it owns, so ask it.
 */
async function redirectChain(timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    last = await netdLogs()
    const chain = /\bchain=(YAAC_RDR_\w+)/.exec(last)?.[1]
    if (chain) return chain
    // A just-replaced netd is Ready before its log is necessarily
    // readable, so poll rather than failing the first empty read.
    if (Date.now() >= deadline) {
      throw new Error(`netd never logged its chain (last read error: ${lastNetdLogsError}; `
        + `pods: ${await netdDiagnostics()}):\n${last.slice(-500)}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Assert this install's jump really is appended into nat PREROUTING. */
async function preroutingJumps(): Promise<string[]> {
  const stdout = await netdExec(['iptables-legacy', '-t', 'nat', '-S', 'PREROUTING'])
  return stdout.split('\n').filter(Boolean)
}

/** This install's whole redirect chain, as `iptables -S` lines. */
async function redirectChainRules(): Promise<string[]> {
  const stdout = await netdExec(['iptables-legacy', '-t', 'nat', '-S', await redirectChain()])
  return stdout.split('\n').filter(Boolean)
}

/**
 * A synced-pod-shaped pod: what the vcluster syncer would land in a
 * vcluster's host namespace. The managed-by label is the one a tenant can
 * neither forge nor shed, and the one containment keys on. Returns its IP.
 */
async function startSyncedPod(name: string, namespace: string, vcName: string): Promise<string> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: { 'vcluster.loft.sh/managed-by': vcName, 'yaac.test': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [{
        name: 'synced',
        image: await resolveTestBaseImageRef(),
        imagePullPolicy: 'IfNotPresent',
      }],
    },
  })
  interface RawPod { status?: { phase?: string; podIP?: string } }
  const deadline = Date.now() + 120_000
  for (;;) {
    const pod = await kubectlGetJson<RawPod>(['get', 'pod', name, '-n', namespace])
    if (pod?.status?.phase === 'Running' && pod.status.podIP) {
      await focusNetdOnPod(name, namespace)
      return pod.status.podIP
    }
    if (Date.now() >= deadline) throw new Error(`synced pod ${name} never ran`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/**
 * Publish validated redirect claims, playing the outer server's role (see
 * packages/server/src/features/cluster/redirect-claims.ts). netd watches this
 * ConfigMap in its own namespace and re-validates every claim in it.
 */
async function publishClaims(data: Record<string, string>): Promise<void> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: REDIRECT_CLAIMS_CM_NAME,
      namespace: k8sNamespace(),
      labels: { app: NETD_APP_NAME, 'yaac.test': 'true' },
    },
    data,
  })
}

interface RawLds {
  resources?: Array<{
    name: string
    filter_chains?: Array<{
      filter_chain_match?: { source_prefix_ranges?: Array<{ address_prefix?: string }> }
      filters: Array<{ typed_config: { cluster: string } }>
    }>
  }>
}

/** The Envoy cluster this pod IP's flows are routed to, per the LDS. */
async function clusterFor(podIp: string): Promise<string> {
  const raw = await netdExec(['cat', '/etc/yaac-envoy/lds.yaml'])
  const doc = JSON.parse(raw) as RawLds
  const https = (doc.resources ?? []).find((r) => r.name.endsWith('-https'))
  const chain = (https?.filter_chains ?? []).find((c) =>
    (c.filter_chain_match?.source_prefix_ranges ?? [])
      .some((range) => range.address_prefix === podIp))
  return chain?.filters[0]?.typed_config.cluster ?? ''
}

/** Poll until the pod has a cluster, optionally a DIFFERENT one. */
async function waitForCluster(
  podIp: string, want: string | null, timeoutMs = 90_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await clusterFor(podIp)
    if (got && got !== want) return got
    if (Date.now() >= deadline) return got
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** Every upstream address netd's Envoy is configured to dial. */
async function cdsAddresses(): Promise<string[]> {
  interface RawCds {
    resources?: Array<{
      load_assignment?: {
        endpoints?: Array<{
          lb_endpoints?: Array<{ endpoint?: { address?: { socket_address?: { address?: string } } } }>
        }>
      }
    }>
  }
  const doc = JSON.parse(await netdExec(['cat', '/etc/yaac-envoy/cds.yaml'])) as RawCds
  return (doc.resources ?? []).flatMap((r) =>
    (r.load_assignment?.endpoints ?? []).flatMap((e) =>
      (e.lb_endpoints ?? []).map((lb) => lb.endpoint?.address?.socket_address?.address ?? '')))
    .filter(Boolean)
}

/** The DNAT ports programmed for one pod in a vcluster namespace. */
async function trioPortsFor(namespace: string, pod: string): Promise<number[]> {
  return (await redirectChainRules())
    .filter((l) => l.includes(`yaac:${namespace}/${pod}`))
    .map((l) => Number(/--to-destination \S+:(\d+)/.exec(l)?.[1] ?? 0))
    .filter(Boolean)
    .sort((a, b) => a - b)
}

/** Poll until all three of a pod's DNAT rules are programmed. */
async function waitForTrioPorts(
  namespace: string, pod: string, timeoutMs = 90_000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await trioPortsFor(namespace, pod)
    if (got.length === 3 || Date.now() >= deadline) return got
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** Run a shell command in a pod, never failing the exec. */
async function shInPod(
  pod: string, script: string, timeout = 40_000,
): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectlWithRetry([
    'exec', '-n', k8sNamespace(), pod, '--',
    'sh', '-c', `${script} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout }
}

/** Egress probe: reach the MITM host pinned at an unroutable IP. */
const egressProbe = `curl -sS --max-time 12 --cacert ${CA_PATH} `
  + `--resolve ${MITM_HOST}:443:${FAKE_IP} https://${MITM_HOST}/v1/test -o /dev/null`

async function egressWorks(pod: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await shInPod(pod, egressProbe)).exit === 0) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** Scale the netd DaemonSet to zero by patching its nodeSelector, and back. */
async function setNetdScheduled(scheduled: boolean): Promise<void> {
  // A DaemonSet has no replicas; an impossible nodeSelector is the
  // supported way to take one out of service.
  const patch = scheduled
    ? { spec: { template: { spec: { nodeSelector: null } } } }
    : { spec: { template: { spec: { nodeSelector: { 'yaac.e2e/absent': 'true' } } } } }
  await kubectlWithRetry([
    'patch', 'daemonset', NETD_APP_NAME, '-n', k8sNamespace(),
    '--type', 'merge', '-p', JSON.stringify(patch),
  ])
}

/**
 * Wait for the netd DaemonSet to be fully out of service (`0`) or fully
 * back (`'all'`).
 *
 * `'all'` rather than a literal count: a DaemonSet's ready count is one
 * per eligible node, so any fixed number is a bet on the cluster's size.
 * Comparing against `desiredNumberScheduled` asks the question the tests
 * actually mean — "is every instance that should exist back?" — and reads
 * the same on one node as on five.
 */
async function waitForNetdReady(want: 0 | 'all', timeoutMs = 180_000): Promise<void> {
  interface RawDs { status?: { numberReady?: number; desiredNumberScheduled?: number } }
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const ds = await kubectlGetJson<RawDs>([
      'get', 'daemonset', NETD_APP_NAME, '-n', k8sNamespace(),
    ])
    const ready = ds?.status?.numberReady ?? 0
    const desired = ds?.status?.desiredNumberScheduled ?? 0
    last = `ready=${ready} desired=${desired}`
    if (want === 0 ? ready === 0 : desired > 0 && ready === desired) return
    if (Date.now() >= deadline) {
      throw new Error(`netd never reached ${want === 0 ? '0 ready' : 'all ready'} (${last})`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

// Every assertion here reads or mutates the node's dataplane, which a
// nested run has no access to (its redirect lives on the host node).
describe.skipIf(IS_NESTED_YAAC)('netd datapath gates', () => {
  const client = new ProxyClient(TEST_PROXY_CONFIG)
  const suffix = crypto.randomBytes(4).toString('hex')
  const podA = `yaac-netd-a-${suffix}`
  const podLate = `yaac-netd-late-${suffix}`
  const podRaw = `yaac-netd-raw-${suffix}`
  const worktreeA = `netd-a-${suffix}`
  const sessionLate = `netd-late-${suffix}`
  const sessionRaw = `netd-raw-${suffix}`
  let proxyHost = ''

  beforeAll(async () => {
    await client.ensureRunning()
    proxyHost = await proxyServiceClusterIp()
    await client.registerWorktree(worktreeA, {
      rules: [], allowedHosts: [MITM_HOST], tool: 'claude', projectSlug: 'netd-a',
    })
    await client.registerWorktree(sessionLate, {
      rules: [], allowedHosts: [MITM_HOST], tool: 'claude', projectSlug: 'netd-late',
    })
    // The forger gets NOTHING on its allowlist, so any success in the
    // spoof case below is a real attribution failure rather than its own
    // legitimate egress.
    await client.registerWorktree(sessionRaw, {
      rules: [], allowedHosts: [], tool: 'claude', projectSlug: 'netd-raw',
    })
    await startWorktreePod(podA, worktreeA, proxyHost)
    await waitForPodRunning(podA)
  }, 600_000)

  afterAll(async () => {
    // Always restore netd — a leaked nodeSelector would strand every
    // later test in the run with no session egress.
    await setNetdScheduled(true).catch(() => { /* ok */ })
    await waitForNetdReady('all').catch(() => { /* ok */ })
    await Promise.all([deleteTestPod(podA), deleteTestPod(podLate), deleteTestPod(podRaw)])
    try { await client.removeWorktree(worktreeA) } catch { /* ok */ }
    try { await client.removeWorktree(sessionLate) } catch { /* ok */ }
    try { await client.removeWorktree(sessionRaw) } catch { /* ok */ }
    try { await client.stop() } catch { /* ok */ }
  }, 300_000)

  it('programs one redirect rule trio per session pod, keyed on its veth', async () => {
    expect(await egressWorks(podA)).toBe(true)

    interface RawPod { status?: { podIP?: string } }
    const pod = await kubectlGetJson<RawPod>(['get', 'pod', podA, '-n', k8sNamespace()])
    const podIp = pod?.status?.podIP
    expect(podIp).toBeTruthy()

    // netd resolves the pod to the veth its frames arrive on and matches on
    // THAT, not on the source IP — the identity a workload cannot forge.
    const stdout = await netdExec(['sh', '-c', 'ip route show | grep -F " dev cali" || true'])
    const veth = new RegExp(`^${podIp!.replace(/\./g, '\\.')} dev (\\S+)`, 'm').exec(stdout)?.[1]
    expect(veth, `no Calico route for ${podIp}`).toBeTruthy()

    // Poll rather than snapshot: netd is eventually consistent, so the
    // rules for a just-Ready pod may land a beat after its egress does.
    const mine = await (async (): Promise<string[]> => {
      const deadline = Date.now() + 60_000
      let last: string[] = []
      for (;;) {
        last = (await redirectChainRules()).filter((l) => l.includes(`-i ${veth!} `))
        if (last.length === 3 || Date.now() >= deadline) return last
        await new Promise((r) => setTimeout(r, 2000))
      }
    })()
    // https / http / ssh-sentinel.
    expect(mine, `no rules for ${veth} (pod ${podIp})`).toHaveLength(3)
    expect(mine.every((l) => l.includes('-j DNAT'))).toBe(true)

    // World-scoped: pod-to-pod traffic must never be redirected. The
    // exclusions lead the chain as RETURNs — iptables allows one
    // destination per rule, and a cluster can allocate from several CIDRs.
    const all = await redirectChainRules()
    const returns = all.filter((l) => l.includes('-j RETURN'))
    expect(returns.length).toBeGreaterThan(0)
    expect(returns.every((l) => /-d \d+\.\d+\.\d+\.\d+\/\d+ -j RETURN/.test(l))).toBe(true)
    const firstDnat = all.findIndex((l) => l.includes('-j DNAT'))
    const lastReturn = all.map((l) => l.includes('-j RETURN')).lastIndexOf(true)
    expect(lastReturn, 'exclusions must precede every DNAT rule').toBeLessThan(firstDnat)

    // The jump is APPENDED, after Calico's and kube-proxy's — netd must
    // never compete with Felix for position, and landing after
    // KUBE-SERVICES is what keeps ClusterIP traffic out of the redirect.
    const jumps = await preroutingJumps()
    const myChain = await redirectChain()
    const mineAt = jumps.findIndex((l) => l.endsWith(`-j ${myChain}`))
    const caliAt = jumps.findIndex((l) => l.includes('cali-PREROUTING'))
    const kubeAt = jumps.findIndex((l) => l.includes('KUBE-SERVICES'))
    expect(mineAt).toBeGreaterThan(caliAt)
    expect(mineAt).toBeGreaterThan(kubeAt)
  }, 300_000)

  it('never competes with Calico for chain position (survives a Felix restart)', async () => {
    // The constraint that killed the TPROXY design: Felix re-inserts its
    // own jumps at the top of every base chain it manages, so a rule that
    // must run BEFORE cali-* is demoted on every reprogram. netd's jump is
    // appended into nat PREROUTING, which Calico leaves uncontended — so a
    // full Felix restart must change nothing.
    expect(await egressWorks(podA)).toBe(true)
    await kubectlWithRetry([
      'delete', 'pod', '-n', 'kube-system', '-l', 'k8s-app=calico-node', '--wait=false',
    ])
    await kubectlWithRetry([
      'rollout', 'status', 'daemonset/calico-node', '-n', 'kube-system', '--timeout=240s',
    ], { timeout: 250_000 })
    expect(await egressWorks(podA)).toBe(true)
  }, 600_000)

  it('fails CLOSED when netd is absent — a pod born without a redirect has no egress', async () => {
    // The single most important property of the split: netd owns only the
    // redirect, so losing it costs egress and can never grant it. A pod
    // created while netd is gone must reach nothing at all, then gain
    // redirected egress when netd returns.
    await setNetdScheduled(false)
    await waitForNetdReady(0)

    await startWorktreePod(podLate, sessionLate, proxyHost)
    await waitForPodRunning(podLate)

    // Not the redirect target...
    expect((await shInPod(podLate, egressProbe)).exit).not.toBe(0)
    // ...and not the real internet either: 443-to-world matches no rule in
    // the session NetworkPolicy, so it dies on the FORWARD path.
    const direct = await shInPod(
      podLate, 'curl -sS --max-time 10 -o /dev/null https://1.1.1.1/ ',
    )
    expect(direct.exit).not.toBe(0)

    await setNetdScheduled(true)
    await waitForNetdReady('all')
    expect(await egressWorks(podLate)).toBe(true)
  }, 900_000)

  it('reconverges its rules after a netd restart', async () => {
    const rulesFor = async (): Promise<string> => (await redirectChainRules()).join('\n')
    const before = await rulesFor()
    expect(before).toContain('-j DNAT')

    await kubectlWithRetry([
      'delete', 'pod', '-n', k8sNamespace(), '-l', `app=${NETD_APP_NAME}`, '--wait=false',
    ])
    await waitForNetdReady('all')

    // Rebuilt from cluster state, not from anything netd persisted: the
    // reconcile is a pure function of pods + Services + node routes.
    expect(await rulesFor()).toContain('-j DNAT')
    expect(await egressWorks(podA)).toBe(true)
  }, 600_000)

  it('re-asserts a deleted PREROUTING jump and refills a flushed chain, without restarting', async () => {
    // Two independent self-heal paths, damaged together so one reconcile
    // period covers both — the wait, not the damage, is what these cost,
    // and netd's pass is unconditional so repairing both at once proves
    // exactly what repairing them separately did:
    //   - a deleted jump is invisible in netd's rendering (the desired
    //     chain is byte-identical), so nothing but an unconditional
    //     re-assert every pass would ever notice it was gone;
    //   - the write-only-on-change memo describes what netd WROTE, not
    //     what the kernel kept, so only the periodic pass discarding it
    //     heals a flushed chain.
    const chain = await redirectChain()
    await netdExec(['iptables-legacy', '-t', 'nat', '-D', 'PREROUTING', '-j', chain])
    await netdExec(['iptables-legacy', '-t', 'nat', '-F', chain])
    expect((await preroutingJumps()).some((l) => l.endsWith(`-j ${chain}`))).toBe(false)
    expect((await redirectChainRules()).filter((l) => l.includes('-j DNAT'))).toEqual([])

    const deadline = Date.now() + 120_000
    for (;;) {
      const jumpBack = (await preroutingJumps()).some((l) => l.endsWith(`-j ${chain}`))
      const rulesBack = (await redirectChainRules()).some((l) => l.includes('-j DNAT'))
      if (jumpBack && rulesBack) break
      if (Date.now() >= deadline) {
        throw new Error(
          `netd never healed its chain (jump re-asserted: ${jumpBack}, rules refilled: ${rulesBack})`,
        )
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    expect(await egressWorks(podA)).toBe(true)
  }, 600_000)

  it('redirects a synced pod to a CLAIMED proxy pod IP, and back when the claim goes', async () => {
    // The yaac-in-yaac override, asserted on netd's real output rather than
    // through a full vcluster: a synced pod starts on the outer proxy, a
    // validated claim naming a pod IP moves it to that install's proxy, and
    // withdrawing the claim reverts it. This file plays the two roles a real
    // deployment fills — the vcluster syncer (stamping managed-by) and the
    // server (publishing validated claims) — because netd's own behaviour is
    // what is under test here.
    const vcNs = `${k8sNamespace()}-vc-e2e-${suffix}`
    const vcName = `yvc-e2e-${suffix}`
    const installHash = `e2e${suffix}`
    const syncedPod = `yaac-netd-synced-${suffix}`
    const proxyPod = `yaac-netd-inner-proxy-${suffix}`

    try {
      await kubectlApply({
        apiVersion: 'v1', kind: 'Namespace',
        metadata: { name: vcNs, labels: { 'yaac.test': 'true' } },
      })
      const [syncedIp, proxyIp] = await Promise.all([
        startSyncedPod(syncedPod, vcNs, vcName),
        startSyncedPod(proxyPod, vcNs, vcName),
      ])

      // Rule 3: nothing has claimed it, so it rides the OUTER proxy.
      const outerCluster = await waitForCluster(syncedIp, null)
      expect(outerCluster).toMatch(/^yaac-outer-/)
      // Poll: the LDS lists a pod as soon as it has an IP, but its DNAT
      // rules also need Calico's per-workload route, which lands a beat
      // later — so the two are not observable in the same instant.
      const trioBefore = await waitForTrioPorts(vcNs, syncedPod)
      expect(trioBefore).toHaveLength(3)

      // Rule 2: a validated claim appears — publishing it IS the opt-in
      // signal — so the pod moves to the claimed proxy's cluster.
      await publishClaims({
        [vcNs]: JSON.stringify({
          vcluster: vcName,
          claims: [{ install: installHash, proxyPodIp: proxyIp, sources: [syncedIp] }],
        }),
      })
      const innerCluster = await waitForCluster(syncedIp, outerCluster)
      expect(innerCluster, 'the claim did not flip the pod\'s target').toMatch(/^yaac-inner-/)
      // The claimed target is the proxy POD's IP, never a ClusterIP.
      expect(await cdsAddresses()).toContain(proxyIp)

      // The ports did NOT move with the target. Every target shares one
      // trio precisely so a flip cannot strand a flow whose conntrack
      // entry already pins the old destination.
      expect(await trioPortsFor(vcNs, syncedPod)).toEqual(trioBefore)

      // The claimed proxy itself stays on the outer proxy: that is what
      // makes the chain loop-free.
      expect(await clusterFor(proxyIp)).toBe(outerCluster)

      // Back to rule 3 when the claim is withdrawn.
      await publishClaims({})
      expect(await waitForCluster(syncedIp, innerCluster)).toBe(outerCluster)
    } finally {
      await publishClaims({}).catch(() => { /* ok */ })
      await kubectlWithRetry([
        'delete', 'namespace', vcNs, '--ignore-not-found', '--wait=false',
      ]).catch(() => { /* ok */ })
    }
  }, 600_000)

  it('refuses a claim that names an address outside the pod CIDRs', async () => {
    // The bypass this guards, end to end on the real dataplane: a tenant is
    // cluster-admin inside its vcluster, so it can create a `yaac-proxy`
    // Service whose hand-written endpoints name any address on the internet.
    // Honouring such a target would have netd's Envoy dial it FROM THE NODE
    // netns, where kube-proxy resolves it and no NetworkPolicy applies — a
    // full egress tunnel with no allowlist. Only pod IPs the host itself
    // reports are eligible, so every variant below must change nothing.
    const vcNs = `${k8sNamespace()}-vc-evil-${suffix}`
    const vcName = `yvc-evil-${suffix}`
    const syncedPod = `yaac-netd-evil-${suffix}`
    const EXFIL_IP = '203.0.113.7'

    try {
      await kubectlApply({
        apiVersion: 'v1', kind: 'Namespace',
        metadata: { name: vcNs, labels: { 'yaac.test': 'true' } },
      })
      const syncedIp = await startSyncedPod(syncedPod, vcNs, vcName)
      const outerCluster = await waitForCluster(syncedIp, null)
      expect(outerCluster).toMatch(/^yaac-outer-/)

      // A tenant-shaped Service in the vcluster namespace, named and
      // labelled exactly as a synced inner proxy would be, with endpoints
      // pointing off-cluster. Nothing reads Services for the redirect any
      // more, so it must be inert.
      const evilSvc = `yaac-proxy-x-inner-x-${vcName}`
      await kubectlApply({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: evilSvc,
          namespace: vcNs,
          labels: {
            'vcluster.loft.sh/managed-by': vcName,
            'yaac.data-dir-hash': 'evil',
            'yaac.test': 'true',
          },
        },
        spec: { type: 'ClusterIP', ports: [{ port: 10256 }] },
      })
      await kubectlApply({
        apiVersion: 'discovery.k8s.io/v1',
        kind: 'EndpointSlice',
        metadata: {
          name: `${evilSvc}-exfil`,
          namespace: vcNs,
          labels: { 'kubernetes.io/service-name': evilSvc, 'yaac.test': 'true' },
        },
        addressType: 'IPv4',
        ports: [{ port: 10256 }],
        endpoints: [{ addresses: [EXFIL_IP] }],
      })
      const evilClusterIp = (await kubectlGetJson<{ spec?: { clusterIP?: string } }>(
        ['get', 'service', evilSvc, '-n', vcNs],
      ))?.spec?.clusterIP
      expect(evilClusterIp).toBeTruthy()

      // Claims naming, in turn: the off-cluster address directly, that
      // Service's ClusterIP, and an unallocated address inside the pod CIDR.
      for (const target of [EXFIL_IP, evilClusterIp!, '10.244.255.254']) {
        await publishClaims({
          [vcNs]: JSON.stringify({
            vcluster: vcName,
            claims: [{ install: 'evil', proxyPodIp: target, sources: [syncedIp] }],
          }),
        })
        // Give netd a full pass to (not) act on it.
        await new Promise((r) => setTimeout(r, 5000))
        expect(await clusterFor(syncedIp), `netd honoured a claim for ${target}`)
          .toBe(outerCluster)
        const addresses = await cdsAddresses()
        expect(addresses).not.toContain(target)
        expect(addresses).not.toContain(EXFIL_IP)
      }
    } finally {
      await publishClaims({}).catch(() => { /* ok */ })
      await kubectlWithRetry([
        'delete', 'namespace', vcNs, '--ignore-not-found', '--wait=false',
      ]).catch(() => { /* ok */ })
    }
  }, 600_000)

  it('never claims a synced pod in another install\'s vcluster namespace', async () => {
    // netd watches EVERY namespace, and several installs share a node (the
    // real `yaac` one plus this e2e run's). Unscoped, each install's netd
    // DNATs the other's synced pods at its own proxy; both jumps hang off
    // nat PREROUTING by append, so the first-appended chain wins and the
    // loser's pods reach a proxy that cannot resolve them — silent, total
    // egress loss, decided by restart order.
    //
    // Both pods are created up front and the assertion waits for OURS to be
    // programmed, so one reconcile pass has demonstrably seen both. A bare
    // "no rules appeared" check could otherwise pass by running early.
    const ownNs = `${k8sNamespace()}-vc-own-${suffix}`
    const foreignNs = `yaac-sibling-${suffix}-vc-demo`
    const ownPod = `yaac-netd-own-${suffix}`
    const foreignPod = `yaac-netd-foreign-${suffix}`

    const image = await resolveTestBaseImageRef()
    const syncedPodManifest = (name: string, namespace: string): Record<string, unknown> => ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace,
        labels: { 'vcluster.loft.sh/managed-by': `yvc-${suffix}`, 'yaac.test': 'true' },
      },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        containers: [{
          name: 'synced',
          image,
          imagePullPolicy: 'IfNotPresent',
        }],
      },
    })
    const rulesMentioning = async (comment: string): Promise<string[]> => {
      return (await redirectChainRules()).filter((l) => l.includes(comment))
    }
    const waitForRunning = async (name: string, namespace: string): Promise<void> => {
      interface RawPod { status?: { phase?: string } }
      const deadline = Date.now() + 120_000
      for (;;) {
        const p = await kubectlGetJson<RawPod>(['get', 'pod', name, '-n', namespace])
        if (p?.status?.phase === 'Running') return
        if (Date.now() >= deadline) throw new Error(`${namespace}/${name} never ran`)
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    try {
      for (const ns of [ownNs, foreignNs]) {
        await kubectlApply({
          apiVersion: 'v1', kind: 'Namespace',
          metadata: { name: ns, labels: { 'yaac.test': 'true' } },
        })
      }
      await kubectlApply(syncedPodManifest(ownPod, ownNs))
      await kubectlApply(syncedPodManifest(foreignPod, foreignNs))
      await waitForRunning(ownPod, ownNs)
      await waitForRunning(foreignPod, foreignNs)

      // Each pod is judged by the netd on ITS OWN node: these two can land
      // on different nodes, and netd only ever programs local pods, so a
      // single instance would show one of them missing for the mundane
      // reason that it is somewhere else.
      await focusNetdOnPod(ownPod, ownNs)
      const deadline = Date.now() + 90_000
      let ours: string[] = []
      while (Date.now() < deadline) {
        ours = await rulesMentioning(`yaac:${ownNs}/${ownPod}`)
        if (ours.length === 3) break
        await new Promise((r) => setTimeout(r, 2000))
      }
      expect(ours, 'our own vcluster\'s synced pod must still be redirected').toHaveLength(3)
      await focusNetdOnPod(foreignPod, foreignNs)
      expect(
        await rulesMentioning(`yaac:${foreignNs}/${foreignPod}`),
        'netd claimed a sibling install\'s synced pod',
      ).toEqual([])
    } finally {
      await kubectlWithRetry([
        'delete', 'namespace', ownNs, foreignNs, '--ignore-not-found', '--wait=false',
      ]).catch(() => { /* ok */ })
    }
  }, 600_000)

  it('cannot borrow another session\'s identity by forging a source IP', async () => {
    // The redirect is keyed on the veth a frame ARRIVES on, and Envoy
    // stamps the address it actually observes — so spoofing a source IP
    // cannot move a connection onto another session's allowlist. The
    // forger is given an EMPTY allowlist and the victim a permissive one,
    // so any success here is a real attribution failure.
    // A dedicated pod: it needs NET_RAW/NET_ADMIN and the gvisor-nested
    // tier, and a pod spec cannot be patched into that after creation.
    await startWorktreePod(podRaw, sessionRaw, proxyHost, { netRaw: true })
    await waitForPodRunning(podRaw)

    // Sanity: the forger has no allowlist of its own, so it cannot reach
    // the host legitimately. Without this the spoof assertion below could
    // pass simply because everything is broken.
    expect((await shInPod(podRaw, egressProbe)).exit).not.toBe(0)

    interface RawPod { status?: { podIP?: string } }
    const victim = await kubectlGetJson<RawPod>(['get', 'pod', podA, '-n', k8sNamespace()])
    const victimIp = victim?.status?.podIP
    expect(victimIp).toBeTruthy()

    // Baseline: the victim's own allowlist really does permit this host,
    // so a pass below cannot be "the host was blocked for everyone".
    expect(await egressWorks(podA)).toBe(true)

    const spoofed = await shInPod(podRaw,
      `ip addr add ${victimIp}/32 dev eth0 2>/dev/null; `
      + `curl -sS --max-time 12 --interface ${victimIp} --cacert ${CA_PATH} `
      + `--resolve ${MITM_HOST}:443:${FAKE_IP} https://${MITM_HOST}/v1/test -o /dev/null`)
    expect(spoofed.exit, 'a pod reached a host only the VICTIM session is allowed — '
      + `source-IP attribution was forged (out: ${spoofed.out.slice(0, 200)})`).not.toBe(0)
  }, 900_000)
})
