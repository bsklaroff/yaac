import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileAsync, k8sNamespace, kubectlApply, kubectlGetJson } from '@/lib/k8s/kubectl'
import {
  buildProxyIngressCnpManifest,
  buildSessionEgressRedirectCnpManifest,
  ensureNamespace,
  PROXY_APP_NAME,
  TRANSPARENT_HTTPS_PORT,
} from '@/lib/k8s/bootstrap'
import { LABEL_SESSION_ID } from '@/lib/k8s/pods'
import { registryHost, registryReachable, pushImageToRegistry } from '@/lib/k8s/registry'
import { sessionUid } from '@/lib/container/image-builder'
import { getDataDir } from '@/shared/paths'
import { env } from '@/shared/env'

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
  'Create a kind cluster wired for yaac by running:',
  '  yaac cluster setup',
  'It provisions the podman machine (macOS), the local registry, the kind',
  'cluster (registry wiring + home extraMount), Cilium, and the node fixups.',
].join('\n')

/**
 * Node-state the setup applies and this check verifies. Shared with
 * cluster-setup.ts (which imports them) so `yaac cluster setup --repair`
 * and the node-fixups check below can never drift apart.
 */
export const NODE_SYSFS_MOUNTPOINT = '/mnt/sysfs'
export const NODE_TASKSMAX_CONF = '/etc/systemd/system.conf.d/10-yaac-tasksmax.conf'
export const NODE_MIN_FREE_KBYTES = 262144
export const NODE_PIDS_LIMIT = 32768

export interface ClusterCheckDeps {
  /** execFile-style runner, injectable for tests. */
  run: typeof execFileAsync
  registryReachable: () => Promise<boolean>
  pushImage: (localTag: string) => Promise<string>
  ensureNamespace: () => Promise<void>
  apply: (manifest: object) => Promise<void>
}

const defaultDeps: ClusterCheckDeps = {
  run: execFileAsync,
  registryReachable,
  pushImage: pushImageToRegistry,
  ensureNamespace,
  apply: kubectlApply,
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
 *   6b. node fixups (warn-only, kind nodes only): the sysfs unmask,
 *      DefaultTasksMax, vm.min_free_kbytes, and node pids-limit that
 *      `yaac cluster setup` applies all live in node/VM state and vanish
 *      on restart — detect and point at `yaac cluster setup --repair`
 *   7. end-to-end probe: push a tiny image to the registry, run a pod
 *      from `localhost:5001/...` that reads a nonce file from a hostPath
 *      mount of the data dir and writes a marker back at the session uid
 *      — proves in-cluster registry pulls, host-visible hostPath, AND
 *      unprivileged hostPath writes in one shot
 *   8. egress enforcement: a session-labeled pod cannot reach the apiserver
 *      (CNI enforces policy) and cannot dial a proxy transparent port
 *      directly (the forgery lock — its egress default-deny admits no such
 *      route, so only the Cilium redirect can reach those ports)
 *   9. envoy-config: the CiliumEnvoyConfig CRDs exist (the cluster-level
 *      egress redirect needs `envoyConfig.enabled` — `yaac cluster setup`)
 *  10. nested-mount (warn-only): under the nested session securityContext
 *      (userns-scoped SYS_ADMIN, RuntimeDefault) an unprivileged user can
 *      mount tmpfs inside a user namespace — the rootless-podman
 *      prerequisite for nestedContainers sessions
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

  // 6b–7. node fixups + end-to-end probe (skipped when prerequisites
  // already failed)
  const PROBE_GATES = [
    'node-fixups', 'probe', 'egress', 'envoy-config', 'nested-mount',
  ] as const
  if (results.some((r) => r.status === 'fail')) {
    for (const name of PROBE_GATES) {
      add({ name, status: 'skip', detail: 'skipped — fix the failures above first' })
    }
    return { ok: false, results }
  }
  add(await runNodeFixupsCheck(deps))
  add(await runEndToEndProbe(deps))

  // 8. egress-lockdown probe (same prerequisites as the e2e probe, plus
  // the probe image it pushed)
  if (results.some((r) => r.status === 'fail')) {
    for (const name of PROBE_GATES.slice(2)) {
      add({ name, status: 'skip', detail: 'skipped — fix the failures above first' })
    }
    return { ok: false, results }
  }
  // Inner yaac (a vcluster session, YAAC_NESTED=1): the remaining gates
  // probe machinery that deliberately does not exist inside a vcluster, so
  // they self-skip. The egress gate is among them: an inner session's egress
  // default-deny is enforced HOST-side (the daemon projects the redirect for
  // the vcluster's synced pods — see docs/yaac-in-yaac-inner-egress.md), and
  // the vcluster has no Cilium datapath or CRDs, so it cannot be probed from
  // in here (applying the session-egress CNP errors "no matches for kind").
  // The OUTER cluster-check verifies egress. envoy-config / vap likewise have
  // no in-vcluster equivalent; vcluster-in-vcluster is refused.
  if (env.nested) {
    add({ name: 'egress', status: 'skip', detail: 'skipped — nested yaac (inner-session egress is enforced host-side)' })
    for (const name of ['envoy-config', 'nested-mount', 'vap']) {
      add({ name, status: 'skip', detail: 'skipped — nested yaac (not applicable inside a vcluster)' })
    }
    return { ok: !results.some((r) => r.status === 'fail'), results }
  }

  add(await runNetworkPolicyProbe(deps))

  // 9. envoy-config: the CiliumEnvoyConfig CRDs must exist, or the
  // cluster-level egress redirect (the CEC) cannot be applied at all.
  add(await runEnvoyConfigCheck(deps))

  // 10. nested userns-mount probe (warn-only: only nestedContainers
  // sessions need it — the tripwire for containerd versions where the
  // namespaced SYS_ADMIN grant does not unlock the mount family)
  add(await runNestedMountProbe(deps))

  // 10b. ValidatingAdmissionPolicy availability (warn-only: only
  // virtualCluster sessions need it — the synced-pod guard refuses
  // vcluster creation without it, fail-closed)
  add(await runVapAvailabilityCheck(deps))

  return { ok: !results.some((r) => r.status === 'fail'), results }
}

const NODE_FIXUPS_FIX =
  'These fixups live in node/VM state and vanish on a node or VM restart. '
  + 'Re-apply them with: yaac cluster setup --repair'

/**
 * Warn-level detection for the node fixups `yaac cluster setup` applies.
 * Only the sysfs unmask breaks pods immediately (the e2e probe below
 * catches it); the TasksMax / vm.min_free_kbytes / pids-limit fixups fail
 * much later — sessions die mid-flight under subagent fan-out or virtiofs
 * pressure — so sessions can look healthy on a cluster that lost them to a
 * restart. Probing is kind-specific (node name == podman container name,
 * the same assumption project-registry.ts makes): a node that is not a
 * podman container self-skips.
 */
async function runNodeFixupsCheck(deps: ClusterCheckDeps): Promise<CheckResult> {
  if (env.nested) {
    return {
      name: 'node-fixups', status: 'skip',
      detail: 'skipped — nested yaac (no podman-hosted node in here)',
    }
  }
  try {
    const { stdout } = await deps.run('kubectl', [
      'get', 'nodes', '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    const nodes = stdout.trim().split(/\s+/).filter(Boolean)
    if (nodes.length === 0) {
      return { name: 'node-fixups', status: 'warn', detail: 'no nodes found — fixups unverified' }
    }
    const missing = new Set<string>()
    for (const node of nodes) {
      let report: string
      try {
        const res = await deps.run('podman', ['exec', node, 'sh', '-c',
          `mountpoint -q ${NODE_SYSFS_MOUNTPOINT} && echo sysfs=ok || echo sysfs=missing; `
          + `test -f ${NODE_TASKSMAX_CONF} && echo tasksmax=ok || echo tasksmax=missing; `
          + 'echo minfree=$(cat /proc/sys/vm/min_free_kbytes)',
        ])
        report = res.stdout
      } catch {
        return {
          name: 'node-fixups', status: 'skip',
          detail: `node "${node}" is not a podman container — kind node fixups not applicable`,
        }
      }
      if (report.includes('sysfs=missing')) missing.add('sysfs unmask (userns pods)')
      if (report.includes('tasksmax=missing')) missing.add('DefaultTasksMax (subagent fan-out)')
      const minfree = Number(/minfree=(\d+)/.exec(report)?.[1] ?? '0')
      if (minfree < NODE_MIN_FREE_KBYTES) missing.add('vm.min_free_kbytes (virtiofs I/O)')
      const { stdout: pidsRaw } = await deps.run('podman', [
        'inspect', '--format', '{{.HostConfig.PidsLimit}}', node,
      ])
      const pids = Number(pidsRaw.trim())
      if (Number.isFinite(pids) && pids > 0 && pids < NODE_PIDS_LIMIT) {
        missing.add('node pids-limit')
      }
    }
    if (missing.size > 0) {
      return {
        name: 'node-fixups', status: 'warn',
        detail: `missing on the node: ${[...missing].join(', ')}`,
        fix: NODE_FIXUPS_FIX,
      }
    }
    return {
      name: 'node-fixups', status: 'pass',
      detail: 'sysfs unmask, TasksMax, vm sysctls, and pids-limit in place',
    }
  } catch (err) {
    return {
      name: 'node-fixups', status: 'warn',
      detail: `could not verify node fixups (${truncate(err)})`,
      fix: NODE_FIXUPS_FIX,
    }
  }
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
          + 'cluster cannot run user-namespaced pods — run '
          + '`yaac cluster setup --repair` (re-applies the sysfs fix), and '
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
    // The cluster-level egress lockdown: the redirect CNP default-denies
    // session egress (admitting only 443/80→Envoy, the SSH sentinel, DNS,
    // and the in-cluster registry/vcluster ports). That default-deny is ALSO
    // the forgery lock — it leaves no egress rule to the proxy's transparent
    // ports, so a session pod cannot dial one directly to inject a forged
    // PROXY-protocol source. (The proxy-ingress CNP must open those ports to
    // the session-pod identity, since Cilium preserves it through the Envoy
    // redirect — see buildProxyIngressCnpManifest.)
    await deps.apply(buildSessionEgressRedirectCnpManifest())
    await deps.apply(buildProxyIngressCnpManifest())
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

    // When the proxy is deployed, also assert the forgery lock from the
    // same session-labeled pod: it must NOT be able to dial a transparent
    // port directly. The block is on the pod's own egress (the redirect CNP
    // default-deny above), not the proxy ingress. A direct connect that
    // SUCCEEDS would let a pod inject a forged PROXY-protocol source and
    // impersonate another session. Absent proxy → skip this half (it deploys
    // lazily on the first session create).
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
        + ' && echo NP_PROXY_OPEN || echo NP_PROXY_LOCKED'
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
    if (stdout.includes('NP_PROXY_OPEN')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod dialed a proxy transparent port directly — the forgery lock is open, so a pod could impersonate another session',
        fix: 'The session-egress CiliumNetworkPolicy must default-deny egress '
          + 'to the proxy transparent ports (it admits only 443/80→Envoy, the '
          + 'SSH sentinel, DNS, and the in-cluster carve-outs). Restart the '
          + 'yaac daemon so ensureProxyResources re-applies it.',
      }
    }
    if (stdout.includes('NP_BLOCKED')) {
      const proxyHalf = proxyIp
        ? ', and cannot dial a transparent port directly (forgery lock holds)'
        : ' (proxy not deployed — forgery-lock half unverified)'
      return {
        name: 'egress', status: 'pass',
        detail: `session egress is default-denied at the CNI${proxyHalf}`,
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
 * The CiliumEnvoyConfig CRDs must exist: the cluster-level egress redirect is
 * a CEC (buildEgressRedirectCecManifest), and without `envoyConfig.enabled`
 * on the Cilium install the CRD is absent, so the daemon's
 * ensureProxyResources apply would fail and session egress would have no
 * redirect at all. The behavioral gates (redirect / allowlist / forgery lock
 * / DNS stub) are exercised end to end by the transparent-egress e2e suite
 * against a deployed proxy; here we check only the prerequisite.
 */
async function runEnvoyConfigCheck(deps: ClusterCheckDeps): Promise<CheckResult> {
  try {
    const { stdout } = await deps.run('kubectl', [
      'get', 'crd', 'ciliumenvoyconfigs.cilium.io',
      '-o', 'jsonpath={.metadata.name}',
    ])
    if (stdout.trim() === 'ciliumenvoyconfigs.cilium.io') {
      return {
        name: 'envoy-config', status: 'pass',
        detail: 'CiliumEnvoyConfig CRDs present (cluster-level egress redirect can be applied)',
      }
    }
    return {
      name: 'envoy-config', status: 'fail',
      detail: 'the ciliumenvoyconfigs.cilium.io CRD is missing — the egress-redirect CEC cannot be created',
      fix: 'Cilium was installed without envoyConfig. Re-run '
        + '`yaac cluster setup` (it installs Cilium with envoyConfig.enabled=true), '
        + 'or `cilium upgrade --reuse-values --set envoyConfig.enabled=true`.',
    }
  } catch (err) {
    return {
      name: 'envoy-config', status: 'fail',
      detail: `could not query CRDs (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    }
  }
}

const NESTED_PROBE_POD_NAME = 'yaac-cluster-check-nested'

/**
 * Warn-level gate for nestedContainers sessions: under the exact nested
 * session securityContext — hostUsers: false, seccomp RuntimeDefault, the
 * unprivileged session uid with a userns-scoped SYS_ADMIN grant — an
 * `unshare -U -r -m` user namespace must be able to mount tmpfs. That is
 * the rootless-podman prerequisite (overlay/proc/tmpfs mounts inside the
 * userns it creates; `docker build` RUN steps cannot avoid mount()): the
 * cap makes containerd's static RuntimeDefault profile compile the
 * mount-family syscalls into the seccomp allowlist. A containerd version
 * that doesn't unlock the family via the namespaced cap fails here.
 */
async function runNestedMountProbe(deps: ClusterCheckDeps): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const imageRef = await deps.pushImage(PROBE_LOCAL_TAG)
    await deps.run('kubectl', ['delete', 'pod', NESTED_PROBE_POD_NAME, '-n', ns, '--ignore-not-found'])
    await deps.apply({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: NESTED_PROBE_POD_NAME, namespace: ns },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        hostUsers: false,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{
          name: 'probe',
          image: imageRef,
          // The nested session-container securityContext, verbatim (see
          // buildSessionJobManifest's nested branch).
          securityContext: {
            runAsUser: sessionUid(),
            capabilities: { add: ['SYS_ADMIN'] },
            allowPrivilegeEscalation: true,
          },
          command: [
            'sh', '-c',
            'mkdir -p /tmp/m && '
            + "unshare -U -r -m sh -c 'mount -t tmpfs none /tmp/m' "
            + '&& echo NESTED_MOUNT_OK || echo NESTED_MOUNT_FAIL',
          ],
        }],
      },
    })

    const phase = await waitForProbePodPhase(NESTED_PROBE_POD_NAME, 'Succeeded', 60_000)
    if (phase !== 'Succeeded') {
      return {
        name: 'nested-mount', status: 'warn',
        detail: `nested probe pod ended in phase ${phase} — nestedContainers sessions unverified`,
        fix: NESTED_MOUNT_FIX,
      }
    }
    const { stdout } = await deps.run('kubectl', ['logs', NESTED_PROBE_POD_NAME, '-n', ns])
    if (stdout.includes('NESTED_MOUNT_OK')) {
      return {
        name: 'nested-mount', status: 'pass',
        detail: 'userns-scoped SYS_ADMIN unlocks rootless mounts (nestedContainers ready)',
      }
    }
    return {
      name: 'nested-mount', status: 'warn',
      detail: 'mounting tmpfs inside a user namespace failed under the nested securityContext'
        + ` (logs: ${stdout.trim().slice(0, 80) || 'empty'})`,
      fix: NESTED_MOUNT_FIX,
    }
  } catch (err) {
    return {
      name: 'nested-mount', status: 'warn',
      detail: `nested userns-mount probe errored (${truncate(err)})`,
      fix: NESTED_MOUNT_FIX,
    }
  } finally {
    await deps.run('kubectl', ['delete', 'pod', NESTED_PROBE_POD_NAME, '-n', ns, '--ignore-not-found'])
      .catch(() => { /* best-effort cleanup */ })
  }
}

const NESTED_MOUNT_FIX =
  'Only nestedContainers sessions are affected (docker build/run in-pod). '
  + 'This containerd version does not unlock the mount syscall family via '
  + 'the userns-scoped SYS_ADMIN grant — nested sessions on this cluster '
  + 'cannot mount overlay/proc/tmpfs inside their build userns.'

/**
 * Warn-only gate for virtualCluster sessions: the synced-pod guard is a
 * ValidatingAdmissionPolicy, and vcluster creation refuses to proceed
 * without the API (fail-closed, no opt-out).
 */
async function runVapAvailabilityCheck(deps: ClusterCheckDeps): Promise<CheckResult> {
  try {
    await deps.run('kubectl', ['get', 'validatingadmissionpolicies', '-o', 'name'], {
      timeout: 15_000,
    })
    return {
      name: 'vap', status: 'pass',
      detail: 'ValidatingAdmissionPolicy API available (vcluster synced-pod guard)',
    }
  } catch (err) {
    return {
      name: 'vap', status: 'warn',
      detail: `ValidatingAdmissionPolicy API unavailable (${truncate(err)})`,
      fix: 'Only virtualCluster sessions are affected — their synced-pod '
        + 'guard needs the ValidatingAdmissionPolicy API (kubernetes >= '
        + '1.30, enabled by default). vcluster creation fails closed '
        + 'without it.',
    }
  }
}

function truncate(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg.split('\n')[0]
}
