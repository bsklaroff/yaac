import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileAsync, k8sNamespace, kubectlApply, kubectlGetJson } from '@/lib/k8s/kubectl'
import {
  buildSessionNetworkPolicyManifest,
  CLUSTER_SERVICE_CIDR,
  clusterIpForNamespace,
  ensureNamespace,
  PROXY_APP_NAME,
  RELAY_DNS_PORT,
  RELAY_UID,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_TUNNEL_PORT,
} from '@/lib/k8s/bootstrap'
import { LABEL_SESSION_ID } from '@/lib/k8s/pods'
import { ensureRedirectInitImage } from '@/lib/k8s/redirect-init'
import { ensureRelayImage } from '@/lib/k8s/relay'
import { registryHost, registryReachable, pushImageToRegistry } from '@/lib/k8s/registry'
import { sessionUid } from '@/lib/container/image-builder'
import { getDataDir } from '@/shared/paths'

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
  /** Actionable fix instructions, printed only on fail/warn. */
  fix?: string
}

/** Render one result as the CLI line `yaac cluster check` prints. */
export function formatCheckResult(r: CheckResult): string {
  const icon = { pass: '✓', fail: '✗', warn: '!', skip: '-' }[r.status]
  const head = `${icon} ${r.name}: ${r.detail}`
  return r.fix && r.status !== 'pass' && r.status !== 'skip'
    ? `${head}\n    fix: ${r.fix.split('\n').join('\n         ')}`
    : head
}

/** Probe image used for the end-to-end registry-pull + hostPath check. */
const PROBE_SOURCE_IMAGE = 'docker.io/library/busybox:1.36'
const PROBE_LOCAL_TAG = 'yaac-cluster-probe:busybox-1.36'
const PROBE_POD_NAME = 'yaac-cluster-check'

const KIND_SETUP_FIX = [
  'Create a kind cluster wired for yaac (registry + home extraMount):',
  '  see "Cluster setup" in the yaac README — it provides a',
  '  kind-config.yaml with the local-registry containerd patch and an',
  '  extraMounts entry for your home directory.',
].join('\n')

export interface ClusterCheckDeps {
  /** execFile-style runner, injectable for tests. */
  run: typeof execFileAsync
  registryReachable: () => Promise<boolean>
  pushImage: (localTag: string) => Promise<string>
  ensureNamespace: () => Promise<void>
  apply: (manifest: object) => Promise<void>
  /** Build/push the redirect-init image; returns its in-cluster ref. */
  ensureRedirectInitImage: () => Promise<string>
  /** Build/push the relay image; returns its in-cluster ref. */
  ensureRelayImage: () => Promise<string>
}

const defaultDeps: ClusterCheckDeps = {
  run: execFileAsync,
  registryReachable,
  pushImage: pushImageToRegistry,
  ensureNamespace,
  apply: kubectlApply,
  // Never require pre-built images here: the preflight builds for real so
  // it also validates that the redirect-init / relay contexts build at all.
  ensureRedirectInitImage: () => ensureRedirectInitImage(false),
  ensureRelayImage: () => ensureRelayImage(false),
}

/**
 * Run the full preflight suite for the kubernetes backend. Returns every
 * result plus an overall ok flag (false when any hard check failed).
 *
 * Checks, in order:
 *   1. kubectl binary present
 *   2. cluster API server reachable
 *   3. single-node cluster (warn otherwise — hostPath mounts assume
 *      node == host)
 *   4. podman present (the image build engine)
 *   5. local registry answering on the configured address
 *   6. yaac namespace exists / can be created
 *   7. end-to-end probe: push a tiny image to the registry, run a pod
 *      from `localhost:5001/...` that reads a nonce file from a hostPath
 *      mount of the data dir and writes a marker back at the session uid
 *      — proves in-cluster registry pulls, host-visible hostPath, AND
 *      unprivileged hostPath writes in one shot
 *   8. egress NetworkPolicy enforcement (the pod-scoped backstop layer)
 *   9. transparent-egress gates from one session-shaped pod: redirect
 *      (nat REDIRECT delivers to the loopback relay), lockdown (filter
 *      default-deny REJECTs non-proxy egress fast), dns-stub (udp/53 is
 *      answered by the relay's stub, never kube-dns)
 *  10. proxy Service VIP pin drift (warn-only)
 *  11. service-CIDR drift (warn-only)
 */
export async function runClusterCheck(
  deps: ClusterCheckDeps = defaultDeps,
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  const add = (r: CheckResult): void => { results.push(r) }

  // 1. kubectl present
  try {
    await deps.run('kubectl', ['version', '--client', '--output', 'json'])
    add({ name: 'kubectl', status: 'pass', detail: 'installed' })
  } catch {
    add({
      name: 'kubectl', status: 'fail', detail: 'not found on PATH',
      fix: 'Install kubectl: https://kubernetes.io/docs/tasks/tools/',
    })
    return { ok: false, results }
  }

  // 2. cluster reachable
  try {
    await deps.run('kubectl', ['version', '--output', 'json'], { timeout: 10_000 })
    add({ name: 'cluster', status: 'pass', detail: 'API server reachable' })
  } catch (err) {
    add({
      name: 'cluster', status: 'fail',
      detail: `API server unreachable (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    })
    return { ok: false, results }
  }

  // 3. single-node
  try {
    const { stdout } = await deps.run('kubectl', ['get', 'nodes', '-o', 'json'])
    const nodes = (JSON.parse(stdout) as { items: unknown[] }).items
    if (nodes.length === 1) {
      add({ name: 'nodes', status: 'pass', detail: 'single-node cluster' })
    } else {
      add({
        name: 'nodes', status: 'warn',
        detail: `${nodes.length} nodes — yaac v1 assumes single-node (hostPath mounts)`,
        fix: 'Use a single-node cluster (kind with one control-plane node).',
      })
    }
  } catch (err) {
    add({ name: 'nodes', status: 'warn', detail: `could not list nodes (${truncate(err)})` })
  }

  // 4. podman (build engine)
  try {
    await deps.run('podman', ['--version'])
    add({ name: 'podman', status: 'pass', detail: 'installed (image build engine)' })
  } catch {
    add({
      name: 'podman', status: 'fail', detail: 'not found on PATH',
      fix: 'Install podman — yaac builds session images with it.',
    })
  }

  // 5. registry
  if (await deps.registryReachable()) {
    add({ name: 'registry', status: 'pass', detail: `answering on ${registryHost()}` })
  } else {
    add({
      name: 'registry', status: 'fail',
      detail: `nothing answering on ${registryHost()}`,
      fix: 'The yaac daemon auto-starts a registry container on startup.\n'
        + 'Start it manually with:\n'
        + '  podman run -d --name yaac-registry -p 127.0.0.1:5001:5000 docker.io/library/registry:2',
    })
  }

  // 6. namespace
  try {
    await deps.ensureNamespace()
    add({ name: 'namespace', status: 'pass', detail: `"${k8sNamespace()}" present` })
  } catch (err) {
    add({
      name: 'namespace', status: 'fail',
      detail: `cannot create namespace "${k8sNamespace()}" (${truncate(err)})`,
      fix: 'Check your kubeconfig context has admin rights on the cluster.',
    })
  }

  // 7. end-to-end probe (skipped when prerequisites already failed)
  const PROBE_GATES = ['probe', 'egress', 'redirect', 'lockdown', 'dns-stub'] as const
  if (results.some((r) => r.status === 'fail')) {
    for (const name of PROBE_GATES) {
      add({ name, status: 'skip', detail: 'skipped — fix the failures above first' })
    }
    // The VIP pin and service-CIDR drift checks only need kubectl + a
    // reachable cluster, which held if we got this far.
    add(await runProxyVipPinCheck(deps))
    add(await runServiceCidrDriftCheck(deps))
    return { ok: false, results }
  }
  add(await runEndToEndProbe(deps))

  // 8. egress-lockdown probe (same prerequisites as the e2e probe, plus
  // the probe image it pushed)
  if (results.some((r) => r.status === 'fail')) {
    for (const name of PROBE_GATES.slice(1)) {
      add({ name, status: 'skip', detail: 'skipped — fix the failures above first' })
    }
    add(await runProxyVipPinCheck(deps))
    add(await runServiceCidrDriftCheck(deps))
    return { ok: false, results }
  }
  add(await runNetworkPolicyProbe(deps))

  // 9. transparent-redirect + lockdown + dns-stub gates — the hard gates
  // for the env-var-free egress design (there is no env-proxy fallback
  // path), all collected from one session-shaped probe pod
  for (const r of await runTransparentRedirectProbe(deps)) add(r)

  // 10. proxy VIP pin (warn-only drift check, like the service CIDR
  // below: session relays dial the pinned VIP from env)
  add(await runProxyVipPinCheck(deps))

  // 11. service-CIDR drift (warn-only: the VIP pin hashes into the
  // compiled service subnet, so a drifted cluster fails the proxy
  // Service creation — loudly — on the next daemon start)
  add(await runServiceCidrDriftCheck(deps))

  return { ok: !results.some((r) => r.status === 'fail'), results }
}

/**
 * The one check that exercises the full wiring: registry pull from inside
 * the cluster plus host-visible hostPath mounts. Failure modes map to the
 * two pieces of cluster setup yaac cannot do itself (containerd registry
 * config, node extraMounts).
 */
async function runEndToEndProbe(deps: ClusterCheckDeps): Promise<CheckResult> {
  const dataDir = getDataDir()
  const nonce = crypto.randomUUID()
  const nonceFile = path.join(dataDir, '.cluster-check-nonce')
  const writeFile = path.join(dataDir, '.cluster-check-write')
  const ns = k8sNamespace()

  try {
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(nonceFile, nonce)
    await fs.rm(writeFile, { force: true })

    // Make sure the probe image exists locally, then push it through the
    // same registry path session images take.
    try {
      await deps.run('podman', ['image', 'inspect', PROBE_LOCAL_TAG])
    } catch {
      await deps.run('podman', ['pull', PROBE_SOURCE_IMAGE], { timeout: 120_000 })
      await deps.run('podman', ['tag', PROBE_SOURCE_IMAGE, PROBE_LOCAL_TAG])
    }
    const imageRef = await deps.pushImage(PROBE_LOCAL_TAG)

    await deps.run('kubectl', ['delete', 'pod', PROBE_POD_NAME, '-n', ns, '--ignore-not-found'])
    const manifest = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: PROBE_POD_NAME, namespace: ns },
      spec: {
        restartPolicy: 'Never',
        // Mirror the session-pod hardening (see buildSessionJobManifest):
        // the probe must prove the cluster can run user-namespaced pods
        // with idmapped hostPath mounts, not just pull images.
        hostUsers: false,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{
          name: 'probe',
          image: imageRef,
          // Run at the uid session images bake into their yaac user, and
          // prove a hostPath WRITE works at that uid — session setup's
          // first unprivileged write (the worktree gitdir pointer) fails
          // exactly here when the uids don't line up.
          securityContext: { runAsUser: sessionUid() },
          command: [
            'sh', '-c',
            'cat /probe/.cluster-check-nonce && echo ok > /probe/.cluster-check-write',
          ],
          volumeMounts: [{ name: 'probe', mountPath: '/probe' }],
        }],
        volumes: [{ name: 'probe', hostPath: { path: dataDir, type: 'Directory' } }],
      },
    }
    await deps.apply(manifest)

    // Poll for completion; image-pull errors and hostPath failures both
    // surface here.
    const deadline = Date.now() + 90_000
    let phase = 'Pending'
    while (Date.now() < deadline) {
      const pod = await kubectlGetJson<{ status?: { phase?: string } }>([
        'get', 'pod', PROBE_POD_NAME, '-n', ns,
      ])
      phase = pod?.status?.phase ?? 'Unknown'
      if (phase === 'Succeeded' || phase === 'Failed') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (phase !== 'Succeeded') {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod ended in phase ${phase}`,
        fix: 'If the pod is stuck in ImagePullBackOff, the cluster cannot '
          + `pull from ${registryHost()} — wire the registry into the `
          + 'cluster (kind local-registry setup).\nIf it failed mounting '
          + `/probe, the node cannot see ${dataDir} — add an extraMounts `
          + 'entry for your home directory to the kind config.\n'
          + 'If it failed with a sysfs or MOUNT_ATTR_IDMAP error, the '
          + 'cluster cannot run user-namespaced pods — re-run '
          + 'scripts/setup-kind-cluster.sh (applies the sysfs fix), and '
          + 'on macOS use the libkrun podman-machine provider with '
          + 'libkrun-efi >= 1.17 (see "Cluster setup" in the README).\n'
          + 'If it failed writing /probe/.cluster-check-write, uid '
          + `${sessionUid()} cannot write hostPath mounts — see the uid `
          + 'notes in "Cluster setup" in the README.',
      }
    }
    const { stdout } = await deps.run('kubectl', ['logs', PROBE_POD_NAME, '-n', ns])
    if (stdout.trim() !== nonce) {
      return {
        name: 'probe', status: 'fail',
        detail: 'probe pod read stale data from the hostPath mount',
        fix: `The node's view of ${dataDir} is not the host's — check the `
          + 'extraMounts entry in your kind config.',
      }
    }
    // The pod's write must round-trip to the host: this is the daemon-side
    // proof that a session's unprivileged uid can mutate hostPath mounts
    // (worktree, config dirs) — a read-only probe passes on clusters where
    // every session still dies on its first write.
    const written = await fs.readFile(writeFile, 'utf8').catch(() => null)
    if (written?.trim() !== 'ok') {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod's hostPath write (uid ${sessionUid()}) did not reach the host`,
        fix: 'Session pods write hostPath mounts as the yaac user, whose '
          + 'uid is baked in at image build time to match the daemon\'s. '
          + 'Rebuild session images (delete stale yaac-base/yaac-tools '
          + 'tags) and check the idmapped-mount notes in "Cluster setup" '
          + 'in the README.',
      }
    }
    return {
      name: 'probe', status: 'pass',
      detail: `registry pull + hostPath mount + uid ${sessionUid()} write verified`,
    }
  } catch (err) {
    return {
      name: 'probe', status: 'fail',
      detail: `probe errored (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    }
  } finally {
    await deps.run('kubectl', ['delete', 'pod', PROBE_POD_NAME, '-n', ns, '--ignore-not-found'])
      .catch(() => { /* best-effort cleanup */ })
    await fs.rm(nonceFile, { force: true }).catch(() => { /* best-effort */ })
    await fs.rm(writeFile, { force: true }).catch(() => { /* best-effort */ })
  }
}

const NETPOL_PROBE_POD_NAME = 'yaac-cluster-check-egress'

/**
 * Verify the CNI actually enforces the session egress NetworkPolicy. A
 * policy on a non-enforcing CNI silently fails OPEN — sessions would have
 * unrestricted egress and the proxy allowlist would be advisory. The
 * probe pod carries the session-id label (so the policy selects it; it
 * stays invisible to listSessionPods, which also filters on this
 * install's data-dir-hash) and tries to reach the kube-apiserver's
 * ClusterIP — always present, always reachable in the absence of policy,
 * and addressed by IP so the verdict does not depend on DNS.
 */
async function runNetworkPolicyProbe(deps: ClusterCheckDeps): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    await deps.apply(buildSessionNetworkPolicyManifest())
    const { stdout: rawIp } = await deps.run('kubectl', [
      'get', 'svc', 'kubernetes', '-n', 'default', '-o', 'jsonpath={.spec.clusterIP}',
    ])
    const apiserverIp = rawIp.trim()
    if (!apiserverIp) {
      return {
        name: 'egress', status: 'warn',
        detail: 'could not resolve the apiserver ClusterIP — enforcement unverified',
      }
    }

    // When the proxy is deployed, also assert the *positive* half of the
    // lockdown from the same session-labeled pod: the proxy must be
    // reachable on a transparent transport port — the only ports the
    // policy admits (evaluated post-DNAT against the proxy pod; the
    // explicit port 10255 is deliberately NOT admitted, it serves only
    // the daemon's port-forwarded control API). A plain TCP connect
    // gives the verdict: the listener accepts and only then judges the
    // PP2 credential, so connect-success proves the network path. Absent
    // proxy → skip this half (it deploys lazily on the first session
    // create).
    let proxyIp: string | null = null
    try {
      const { stdout } = await deps.run('kubectl', [
        'get', 'svc', PROXY_APP_NAME, '-n', ns, '-o', 'jsonpath={.spec.clusterIP}',
      ])
      proxyIp = stdout.trim() || null
    } catch {
      proxyIp = null
    }
    const proxyCheck = proxyIp
      ? `; nc -w 4 ${proxyIp} ${TRANSPARENT_HTTPS_PORT} </dev/null >/dev/null 2>&1`
        + ' && echo NP_PROXY_OK || echo NP_PROXY_BLOCKED'
      : ''

    const imageRef = await deps.pushImage(PROBE_LOCAL_TAG)
    await deps.run('kubectl', ['delete', 'pod', NETPOL_PROBE_POD_NAME, '-n', ns, '--ignore-not-found'])
    await deps.apply({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: NETPOL_PROBE_POD_NAME,
        namespace: ns,
        labels: { [LABEL_SESSION_ID]: 'cluster-check-egress-probe' },
      },
      spec: {
        restartPolicy: 'Never',
        containers: [{
          name: 'probe',
          image: imageRef,
          command: [
            'sh', '-c',
            `nc -w 4 ${apiserverIp} 443 </dev/null && echo NP_REACHED || echo NP_BLOCKED${proxyCheck}`,
          ],
        }],
      },
    })

    const deadline = Date.now() + 60_000
    let phase = 'Pending'
    while (Date.now() < deadline) {
      const pod = await kubectlGetJson<{ status?: { phase?: string } }>([
        'get', 'pod', NETPOL_PROBE_POD_NAME, '-n', ns,
      ])
      phase = pod?.status?.phase ?? 'Unknown'
      if (phase === 'Succeeded' || phase === 'Failed') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (phase !== 'Succeeded') {
      return {
        name: 'egress', status: 'fail',
        detail: `egress probe pod ended in phase ${phase}`,
        fix: KIND_SETUP_FIX,
      }
    }

    const { stdout } = await deps.run('kubectl', ['logs', NETPOL_PROBE_POD_NAME, '-n', ns])
    if (stdout.includes('NP_REACHED')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod reached the apiserver directly — the CNI is not enforcing NetworkPolicy',
        fix: 'Session egress lockdown fails open without NetworkPolicy '
          + 'enforcement, leaving the proxy allowlist advisory. Use a recent '
          + 'kind release (its kindnet CNI enforces NetworkPolicy), or '
          + 'install an enforcing CNI / the kube-network-policies agent.',
      }
    }
    if (stdout.includes('NP_PROXY_BLOCKED')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod cannot reach the proxy on its transport port — sessions would have no egress at all',
        fix: 'The egress NetworkPolicy must admit TCP '
          + `${TRANSPARENT_HTTPS_PORT}/${TRANSPARENT_HTTP_PORT}/${TRANSPARENT_TUNNEL_PORT} `
          + 'to proxy pods. Restart the yaac daemon (ensureProxyResources '
          + 're-applies the policy) and re-run this check.',
      }
    }
    if (stdout.includes('NP_BLOCKED')) {
      const proxyHalf = proxyIp
        ? ', proxy reachable on transport port'
        : ' (proxy not deployed — positive half unverified)'
      return {
        name: 'egress', status: 'pass',
        detail: `session egress locked to the proxy transport ports (NetworkPolicy enforced${proxyHalf})`,
      }
    }
    return {
      name: 'egress', status: 'fail',
      detail: `egress probe produced no verdict (logs: ${stdout.trim().slice(0, 80) || 'empty'})`,
      fix: KIND_SETUP_FIX,
    }
  } catch (err) {
    return {
      name: 'egress', status: 'fail',
      detail: `egress probe errored (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    }
  } finally {
    await deps.run('kubectl', ['delete', 'pod', NETPOL_PROBE_POD_NAME, '-n', ns, '--ignore-not-found'])
      .catch(() => { /* best-effort cleanup */ })
  }
}

const REDIRECT_PROBE_POD_NAME = 'yaac-cluster-check-redirect'
const RELAY_PROBE_PORT = 15001
/** TEST-NET-1: never routable, so a recovered dst proves the REDIRECT. */
const REDIRECT_PROBE_TARGET_IP = '192.0.2.10'
/** The relay stub's fixed A answer — keep in sync with k8s/relay/relay.ts. */
const DNS_STUB_DUMMY_IP = '198.18.0.1'

/** Poll a pod until it reaches a wanted phase (or any terminal one). */
async function waitForProbePodPhase(
  name: string,
  wanted: 'Running' | 'Succeeded',
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let phase = 'Pending'
  while (Date.now() < deadline) {
    const pod = await kubectlGetJson<{ status?: { phase?: string } }>([
      'get', 'pod', name, '-n', k8sNamespace(),
    ])
    phase = pod?.status?.phase ?? 'Unknown'
    if (phase === wanted || phase === 'Succeeded' || phase === 'Failed') return phase
    await new Promise((r) => setTimeout(r, 1000))
  }
  return phase
}

/**
 * The transparent-egress hard gates. With the proxy env vars gone there
 * is no fallback routing path, so the cluster must prove, end to end with
 * the real redirect-init + relay images, that under the session-pod
 * hardening (NET_ADMIN init container in a hostUsers:false, session-
 * labeled pod) the whole pod-netns layer works. One self-contained pod
 * yields three verdicts:
 *
 *   - redirect: a dial to a never-routable IP reaches the loopback relay
 *     (probe mode prints REDIRECT_OK on the first connection and exits) —
 *     only the nat REDIRECT can carry it there.
 *   - dns-stub: resolving a `.invalid` name returns the stub's dummy IP —
 *     proves the udp/53 REDIRECT beat the in-cluster CIDR RETURNs (a real
 *     resolver would answer NXDOMAIN).
 *   - lockdown: a TCP connect to kube-dns's VIP :53 (in-cluster, not a
 *     proxy port) is refused FAST — proves the filter default-deny REJECT
 *     and owner-match uid translation under the pod userns. A slow
 *     refusal means only the NetworkPolicy DROP (the pod-scoped backstop)
 *     caught it; a connect means both layers failed open.
 *
 * No proxy, no Service, no socket-LB or source-IP-preservation
 * requirement (the relay dials the proxy as an ordinary client in
 * production).
 */
async function runTransparentRedirectProbe(deps: ClusterCheckDeps): Promise<CheckResult[]> {
  const ns = k8sNamespace()
  const cleanup = async (): Promise<void> => {
    await deps.run('kubectl', [
      'delete', 'pod', REDIRECT_PROBE_POD_NAME,
      '-n', ns, '--ignore-not-found', '--grace-period=1',
    ]).catch(() => { /* best-effort */ })
  }
  const skipped = (detail: string): CheckResult[] => ([
    { name: 'lockdown', status: 'skip', detail },
    { name: 'dns-stub', status: 'skip', detail },
  ])

  try {
    const [redirectImage, relayImage] = await Promise.all([
      deps.ensureRedirectInitImage(),
      deps.ensureRelayImage(),
    ])

    // The lockdown gate's in-cluster TCP target. kube-dns is ideal: always
    // present with a real tcp/53 listener, so a cluster where neither the
    // filter nor NetworkPolicy bites yields a *connect* verdict, not an
    // ambiguous refusal. Fall back to the conventional .10 slot.
    let denyTargetIp = ''
    try {
      const { stdout } = await deps.run('kubectl', [
        'get', 'svc', 'kube-dns', '-n', 'kube-system', '-o', 'jsonpath={.spec.clusterIP}',
      ])
      denyTargetIp = stdout.trim()
    } catch { /* fall through to the conventional slot */ }
    if (!denyTargetIp) {
      const base = CLUSTER_SERVICE_CIDR.split('/')[0].split('.')
      denyTargetIp = `${base[0]}.${base[1]}.${base[2]}.10`
    }

    await cleanup()

    // Single session-shaped pod: redirect-init installs the real nat +
    // filter rules, the relay runs in probe mode (HTTPS listener + DNS
    // stub) as the main container, and the script collects the three
    // verdicts in log lines. The session-id label makes the egress
    // NetworkPolicy select the pod, so the lockdown gate's fast/slow
    // timing genuinely separates the in-pod REJECT from the CNI DROP.
    await deps.apply({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: REDIRECT_PROBE_POD_NAME,
        namespace: ns,
        labels: { [LABEL_SESSION_ID]: 'cluster-check-redirect-probe' },
      },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        hostUsers: false,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        initContainers: [{
          name: 'redirect-init',
          image: redirectImage,
          securityContext: { capabilities: { add: ['NET_ADMIN'] } },
          env: [
            { name: 'REDIRECT_HTTPS_PORT', value: String(RELAY_PROBE_PORT) },
            { name: 'REDIRECT_HTTP_PORT', value: String(RELAY_PROBE_PORT + 1) },
            { name: 'REDIRECT_DNS_PORT', value: String(RELAY_DNS_PORT) },
            // The probe container (the relay image) runs as the relay uid,
            // so the filter carve-out applies to it exactly as in sessions.
            // The carve-out targets the pinned VIP, valid whether or not
            // the proxy is deployed yet (the probe never dials it).
            { name: 'RELAY_UID', value: String(RELAY_UID) },
            { name: 'PROXY_CLUSTER_IP', value: clusterIpForNamespace(ns) },
            { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
            { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
            { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
          ],
        }],
        containers: [{
          name: 'probe',
          image: relayImage,
          workingDir: '/app',
          env: [
            { name: 'RELAY_PROBE', value: '1' },
            { name: 'LISTEN_HTTPS_PORT', value: String(RELAY_PROBE_PORT) },
            { name: 'LISTEN_DNS_PORT', value: String(RELAY_DNS_PORT) },
          ],
          // Background the relay (probe mode: HTTPS listener + DNS stub),
          // then run the three gates. The redirect dial goes LAST — the
          // probe relay exits on its first TCP connection.
          command: ['sh', '-c', [
            './node_modules/.bin/tsx relay.ts &',
            'sleep 4',
            // dns-stub gate: resolve4 queries the resolv.conf nameserver
            // (kube-dns's VIP) over udp; only the REDIRECT can turn a
            // .invalid name into the stub's dummy answer.
            'node -e "require(\'dns\').promises.resolve4(\'yaac-cluster-check.invalid\')'
            + '.then(function(a){console.log(\'RESOLVED:\'+a[0])},'
            + 'function(e){console.log(\'RESOLVED:\'+e.code)})"',
            // lockdown gate: REJECT answers in milliseconds; a CNI DROP
            // burns the full nc timeout. date math separates the two.
            'S=$(date +%s)',
            `if nc -w 5 ${denyTargetIp} 53 </dev/null >/dev/null 2>&1; then`,
            '  echo DENY_CONNECTED',
            'elif [ $(( $(date +%s) - S )) -le 2 ]; then',
            '  echo DENY_FAST',
            'else',
            '  echo DENY_SLOW',
            'fi',
            // redirect gate: the relay prints REDIRECT_OK and exits.
            `nc -w 3 ${REDIRECT_PROBE_TARGET_IP} 443 </dev/null 2>/dev/null || true`,
            'sleep 2',
          ].join('\n')],
        }],
      },
    })

    const phase = await waitForProbePodPhase(REDIRECT_PROBE_POD_NAME, 'Succeeded', 90_000)
    if (phase !== 'Succeeded') {
      const detail = `redirect probe pod ended in phase ${phase}`
      return [{
        name: 'redirect', status: 'fail',
        detail: `${detail} — pod-netns REDIRECT is not working`,
        fix: 'If the init container failed, the node kernel refused '
          + 'pod-netns iptables under NET_ADMIN + hostUsers:false — re-run '
          + 'scripts/setup-kind-cluster.sh.\nIf the probe container failed, '
          + 'the REDIRECT did not deliver to the relay in the pod netns; '
          + `check the pod logs (kubectl logs ${REDIRECT_PROBE_POD_NAME} -n ${ns}).`,
      }, ...skipped(`skipped — ${detail}`)]
    }

    const { stdout } = await deps.run('kubectl', ['logs', REDIRECT_PROBE_POD_NAME, '-n', ns])
    const results: CheckResult[] = []

    if (stdout.includes('REDIRECT_OK')) {
      results.push({
        name: 'redirect', status: 'pass',
        detail: 'pod-netns REDIRECT delivers outbound 443 to the loopback relay',
      })
    } else {
      results.push({
        name: 'redirect', status: 'fail',
        detail: 'the pod-netns REDIRECT did not deliver to the relay'
          + ` (expected "REDIRECT_OK", logs: ${stdout.trim().slice(0, 80) || 'empty'})`,
        fix: 'The pod-netns REDIRECT did not reach the loopback relay — '
          + 're-run scripts/setup-kind-cluster.sh and re-check.',
      })
    }

    if (stdout.includes('DENY_FAST')) {
      results.push({
        name: 'lockdown', status: 'pass',
        detail: 'non-proxy egress REJECTed in-pod (filter default-deny active)',
      })
    } else if (stdout.includes('DENY_CONNECTED')) {
      results.push({
        name: 'lockdown', status: 'fail',
        detail: 'a session-shaped pod reached kube-dns tcp/53 — neither the in-pod filter nor NetworkPolicy blocked it',
        fix: 'The redirect-init filter rules did not take effect AND the '
          + 'CNI is not enforcing NetworkPolicy. Re-run '
          + 'scripts/setup-kind-cluster.sh; if it persists, check that the '
          + 'node kernel ships xt_owner (the init container would crash '
          + 'loudly otherwise).',
      })
    } else if (stdout.includes('DENY_SLOW')) {
      results.push({
        name: 'lockdown', status: 'fail',
        detail: 'non-proxy egress only timed out (NetworkPolicy DROP) — the in-pod filter REJECT is not answering',
        fix: 'The filter default-deny should refuse immediately with '
          + 'tcp-reset; only the pod-scoped NetworkPolicy backstop caught '
          + 'this. Re-run scripts/setup-kind-cluster.sh and re-check.',
      })
    } else {
      results.push({
        name: 'lockdown', status: 'fail',
        detail: `lockdown gate produced no verdict (logs: ${stdout.trim().slice(0, 80) || 'empty'})`,
        fix: KIND_SETUP_FIX,
      })
    }

    const resolved = /RESOLVED:(\S+)/.exec(stdout)?.[1]
    if (resolved === DNS_STUB_DUMMY_IP) {
      results.push({
        name: 'dns-stub', status: 'pass',
        detail: `udp/53 intercepted by the relay DNS stub (answers ${DNS_STUB_DUMMY_IP})`,
      })
    } else {
      results.push({
        name: 'dns-stub', status: 'fail',
        detail: `resolution did not hit the relay stub (expected ${DNS_STUB_DUMMY_IP}, got ${resolved ?? 'no verdict'})`,
        fix: 'The udp/53 REDIRECT must precede the in-cluster CIDR '
          + 'excludes so queries to the kube-dns VIP land on the relay '
          + 'stub. Rebuild the redirect-init image (a stale image misses '
          + 'the DNS rule) and re-run this check.',
      })
    }
    return results
  } catch (err) {
    const detail = `redirect probe errored (${truncate(err)})`
    return [
      { name: 'redirect', status: 'fail', detail, fix: KIND_SETUP_FIX },
      ...skipped(`skipped — ${detail}`),
    ]
  } finally {
    await cleanup()
  }
}

/**
 * Warn when the live proxy Service's ClusterIP drifts from the compiled
 * per-namespace pin. Session relays dial the pinned VIP from their env
 * (no DNS), so a drifted Service strands every NEW session until the
 * daemon re-pins it. Same drift-warning class as the service-CIDR check;
 * skipped while the proxy isn't deployed (it deploys lazily on the first
 * session create).
 */
async function runProxyVipPinCheck(deps: ClusterCheckDeps): Promise<CheckResult> {
  const pinned = clusterIpForNamespace(k8sNamespace())
  try {
    const { stdout } = await deps.run('kubectl', [
      'get', 'svc', PROXY_APP_NAME, '-n', k8sNamespace(), '-o', 'jsonpath={.spec.clusterIP}',
    ])
    const live = stdout.trim()
    if (!live) {
      return { name: 'proxy-vip', status: 'skip', detail: 'proxy not deployed — VIP pin unverified' }
    }
    if (live !== pinned) {
      return {
        name: 'proxy-vip', status: 'warn',
        detail: `proxy Service ClusterIP ${live} drifts from the pinned ${pinned}`,
        fix: 'Session relays dial the pinned VIP from their env. Restart '
          + 'the yaac daemon: ensureProxyResources deletes and re-applies '
          + 'the Service at the pinned address (sessions created before '
          + 'the pin keep working — their relays re-resolve the Service '
          + 'DNS name per connection).',
      }
    }
    return { name: 'proxy-vip', status: 'pass', detail: `proxy Service pinned at ${pinned}` }
  } catch {
    return { name: 'proxy-vip', status: 'skip', detail: 'proxy not deployed — VIP pin unverified' }
  }
}

/**
 * Warn when the live cluster's service subnet drifts from the compiled
 * CLUSTER_SERVICE_CIDR. clusterIpForNamespace hashes the proxy VIP pin
 * into the compiled value, so on a drifted cluster the pinned Service
 * cannot be created ("provided IP is not in the valid range") and the
 * redirect-init filter carve-out would target a nonexistent VIP.
 * kind/kubeadm clusters expose the subnet in kubeadm-config.
 */
async function runServiceCidrDriftCheck(deps: ClusterCheckDeps): Promise<CheckResult> {
  try {
    const { stdout } = await deps.run('kubectl', [
      'get', 'configmap', 'kubeadm-config', '-n', 'kube-system',
      '-o', 'jsonpath={.data.ClusterConfiguration}',
    ])
    const serviceSubnet = /serviceSubnet:\s*(\S+)/.exec(stdout)?.[1]
    if (!serviceSubnet) {
      return {
        name: 'service-cidr', status: 'warn',
        detail: 'could not read serviceSubnet from kubeadm-config — service-CIDR drift unverified',
      }
    }
    if (serviceSubnet !== CLUSTER_SERVICE_CIDR) {
      return {
        name: 'service-cidr', status: 'warn',
        detail: `live service subnet ${serviceSubnet} drifts from the compiled ${CLUSTER_SERVICE_CIDR}`,
        fix: 'The proxy Service VIP pin (clusterIpForNamespace) hashes '
          + 'into the compiled service CIDR, so Service creation will fail '
          + 'on this cluster. Recreate the cluster with '
          + 'k8s/kind-config.yaml (which pins the subnet), or update '
          + 'CLUSTER_SERVICE_CIDR in src/lib/k8s/bootstrap.ts to match '
          + 'your cluster.',
      }
    }
    return {
      name: 'service-cidr', status: 'pass',
      detail: `service subnet ${serviceSubnet} matches the compiled VIP-pin range`,
    }
  } catch (err) {
    return {
      name: 'service-cidr', status: 'warn',
      detail: `could not read the cluster service subnet (${truncate(err)})`,
    }
  }
}

function truncate(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg.split('\n')[0]
}
