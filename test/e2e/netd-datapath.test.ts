import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import {
  requirePodman,
  requireCluster,
  useTestNamespace,
  createTempDataDir,
  cleanupTempDir,
  TEST_PROXY_CONFIG,
} from '@yaac/test-utils/setup'
import { resolveTestBaseImageRef } from '@yaac/test-utils/mock-remotes'
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import { proxyServiceClusterIp } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { NETD_APP_NAME } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
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
 * All of it asserts on the node's real dataplane, so it needs a host with
 * a wired-up cluster.
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

async function waitForPodRunning(
  name: string,
  timeoutMs = 120_000,
  namespace = k8sNamespace(),
): Promise<void> {
  interface RawPod { status?: { phase?: string } }
  const deadline = Date.now() + timeoutMs
  let phase = 'Pending'
  while (Date.now() < deadline) {
    const pod = await kubectlGetJson<RawPod>(['get', 'pod', name, '-n', namespace])
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
      ...runtimeClassSpec({ nested: opts.netRaw }),
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

/** The DNAT ports programmed for one pod. */
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

describe('netd datapath gates', () => {
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

  it('never redirects a worktree pod belonging to another install', async () => {
    // netd watches EVERY namespace, and several installs share a node (the
    // real `yaac` one plus this e2e run's). Unscoped, each install's netd
    // DNATs the other's pods at its own proxy; both jumps hang off nat
    // PREROUTING by append, so the first-appended chain wins and the
    // loser's pods reach a proxy that cannot resolve them — silent, total
    // egress loss, decided by restart order.
    //
    // Both pods exist before the assertion and OURS is waited for, so one
    // reconcile pass has demonstrably seen both. A bare "no rules appeared"
    // check could otherwise pass by running early.
    const foreignNs = `yaac-sibling-${suffix}`
    const foreignPod = `yaac-netd-foreign-${suffix}`

    const rulesMentioning = async (comment: string): Promise<string[]> =>
      (await redirectChainRules()).filter((l) => l.includes(comment))

    try {
      await kubectlApply({
        apiVersion: 'v1', kind: 'Namespace',
        metadata: { name: foreignNs, labels: { 'yaac.test': 'true' } },
      })
      await kubectlApply({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: foreignPod,
          namespace: foreignNs,
          labels: { ...worktreeIdLabels(`netd-foreign-${suffix}`), 'yaac.test': 'true' },
        },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          containers: [{
            name: 'session',
            image: await resolveTestBaseImageRef(),
            imagePullPolicy: 'IfNotPresent',
          }],
        },
      })
      await waitForPodRunning(foreignPod, 120_000, foreignNs)

      // Each pod is judged by the netd on ITS OWN node: these two can land
      // on different nodes, and netd only ever programs local pods, so a
      // single instance would show one of them missing for the mundane
      // reason that it is somewhere else.
      await focusNetdOnPod(podA)
      expect(
        await waitForTrioPorts(k8sNamespace(), podA),
        'our own install\'s worktree pod must still be redirected',
      ).toHaveLength(3)
      await focusNetdOnPod(foreignPod, foreignNs)
      expect(
        await rulesMentioning(`yaac:${foreignNs}/${foreignPod}`),
        'netd claimed a sibling install\'s worktree pod',
      ).toEqual([])
    } finally {
      await kubectlWithRetry([
        'delete', 'namespace', foreignNs, '--ignore-not-found', '--wait=false',
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
