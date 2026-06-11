import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileAsync, k8sNamespace, kubectlApply, kubectlGetJson } from '@/lib/k8s/kubectl'
import { buildSessionNetworkPolicyManifest, ensureNamespace } from '@/lib/k8s/bootstrap'
import { LABEL_SESSION_ID } from '@/lib/k8s/pods'
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
 *   7. end-to-end probe: push a tiny image to the registry, run a pod
 *      from `localhost:5000/...` that reads a nonce file from a hostPath
 *      mount of the data dir and writes a marker back at the session uid
 *      — proves in-cluster registry pulls, host-visible hostPath, AND
 *      unprivileged hostPath writes in one shot
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
        + '  podman run -d --name yaac-registry -p 127.0.0.1:5000:5000 docker.io/library/registry:2',
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
  if (results.some((r) => r.status === 'fail')) {
    add({ name: 'probe', status: 'skip', detail: 'skipped — fix the failures above first' })
    add({ name: 'egress', status: 'skip', detail: 'skipped — fix the failures above first' })
    return { ok: false, results }
  }
  add(await runEndToEndProbe(deps))

  // 8. egress-lockdown probe (same prerequisites as the e2e probe, plus
  // the probe image it pushed)
  if (results.some((r) => r.status === 'fail')) {
    add({ name: 'egress', status: 'skip', detail: 'skipped — fix the failures above first' })
    return { ok: false, results }
  }
  add(await runNetworkPolicyProbe(deps))

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
            `nc -w 4 ${apiserverIp} 443 </dev/null && echo NP_REACHED || echo NP_BLOCKED`,
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
    if (stdout.includes('NP_BLOCKED')) {
      return {
        name: 'egress', status: 'pass',
        detail: 'session egress locked to proxy + DNS (NetworkPolicy enforced)',
      }
    }
    return {
      name: 'egress', status: 'fail',
      detail: 'a session-labeled pod reached the apiserver directly — the CNI is not enforcing NetworkPolicy',
      fix: 'Session egress lockdown fails open without NetworkPolicy '
        + 'enforcement, leaving the proxy allowlist advisory. Use a recent '
        + 'kind release (its kindnet CNI enforces NetworkPolicy), or '
        + 'install an enforcing CNI / the kube-network-policies agent.',
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

function truncate(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg.split('\n')[0]
}
