import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import {
  LABEL_SESSION_ID,
  LABEL_VCLUSTER_MANAGED_BY,
  NESTED_ENGINE_CAPS,
  NETD_APP_NAME,
  PROXY_APP_NAME,
  RELAY_PORT,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  TRANSPARENT_HTTPS_PORT,
  buildPriorityClassManifests,
  execFileAsync,
  isDeferredClusterBootPending,
  k8sNamespace,
  kubectlApply,
  runPodToCompletion,
  runtimeClassSpec,
} from '#platform/k8s'
import {
  buildProxyIngressNpManifest,
  buildSessionEgressNpManifest,
} from './policy-manifests'
import { nodeIpBlocks } from './cluster-cidrs'
import { ensureNamespace } from './proxy-apply'
import { vapAvailable } from './vcluster'
import { registryHost, registryReachable, pushImageToRegistry } from '#platform/container'
import { sessionUid } from '#features/images'
import { sharedRoot } from '@yaac/shared/paths'
import { env } from '@yaac/shared/env'
// CheckResult lives in @yaac/shared/types, not here with its producer, so
// consumers can name the shape without importing the check suite.
import type { CheckResult } from '@yaac/shared/types'

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
  'cluster (registry wiring + home extraMount), Calico, and the node fixups.',
].join('\n')

/**
 * Node-state the setup applies and this check verifies. Shared with
 * cluster-setup.ts (which imports them) so `yaac cluster setup --repair`
 * and the node-fixups check below can never drift apart.
 */
export const NODE_TASKSMAX_CONF = '/etc/systemd/system.conf.d/10-yaac-tasksmax.conf'
export const NODE_MIN_FREE_KBYTES = 262144
export const NODE_PIDS_LIMIT = 32768
/**
 * kubelet cAdvisor housekeeping interval (default 10s). Its per-container
 * process stats readlink EVERY open fd of EVERY process in each container
 * cgroup per tick; a gVisor session sandbox concentrates ~9k host fds in
 * one sentry process (directfs handles, gofer channels), so at the default
 * interval kubelet alone burned 1.5–2 cores on a 5-session node (pprof:
 * >90% in cadvisor processStatsFromProcs → syscall.Readlink). Even at 60s
 * a 4-session node still measured kubelet at ~1.1 cores with >90% of its
 * profile in the same readlink storm, so the interval is stretched to
 * 300s; the cost is slower node-level stats (metrics/eviction reaction) —
 * session OOMs are enforced by the pod memcg limit and are unaffected.
 */
export const NODE_KUBELET_HOUSEKEEPING_INTERVAL = '300s'
/** kubeadm-written kubelet flags file the fixup edits (kind node fs —
 *  persists across node restarts, unlike the sysctl fixups). */
export const NODE_KUBELET_FLAGS_ENV = '/var/lib/kubelet/kubeadm-flags.env'

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
 *   6b. node fixups (warn-only, kind nodes only): DefaultTasksMax,
 *      vm.min_free_kbytes, the kubelet housekeeping interval, and node
 *      pids-limit that `yaac cluster setup` applies — most live in node/VM
 *      state and vanish on restart — detect and point at
 *      `yaac cluster setup --repair`
 *   6c. gvisor: the gvisor/gvisor-nested RuntimeClasses exist AND a pod on
 *      the gvisor class is actually sentry-sandboxed (dmesg fingerprint) —
 *      session pods cannot run without it
 *   7. end-to-end probe: push a tiny image to the registry, run a pod
 *      from `localhost:5001/...` (on the default gvisor tier) that reads
 *      a nonce file from a hostPath mount of the data dir and writes a
 *      marker back at the session uid — proves in-cluster registry
 *      pulls, host-visible hostPath, AND unprivileged hostPath writes
 *      through the gofer in one shot
 *   8. egress enforcement: a session-labeled pod (gvisor, like real
 *      sessions) cannot reach the apiserver (CNI enforces policy) and
 *      cannot dial a proxy transparent port directly (the forgery lock —
 *      those ports are admitted from the node CIDRs only, so nothing but
 *      netd's Envoy can reach them)
 *   9. datapath: calico-node is Ready (NetworkPolicy is enforced at all)
 *      and yaac-netd is Ready (session egress has a redirect). Nested, this
 *      becomes "the claim-mode netd is publishing" — the inner install's own
 *      half of the same guarantee, warn-level until it is deployed
 *  10. nested-mount (warn-only): under the nested session securityContext
 *      (gvisor-nested + the engine's in-sandbox caps) in-sandbox root can
 *      mount a tmpfs — the core sentry prerequisite for the rootful in-pod
 *      engine (nestedContainers; suid/file-caps are covered by the e2e)
 *  11. runtime-stamp (warn-only): every UNTRUSTED pod — session pods
 *      (yaac.session-id label) and vcluster-synced tenant pods (the
 *      syncer's managed-by label) — carries a gvisor-tier
 *      runtimeClassName. Trusted infra (proxy, registries, node-write,
 *      vcluster control planes) deliberately stamps none and runs on runc.
 */
export async function runClusterCheck(
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  const add = (r: CheckResult): void => { results.push(r) }

  // A nested server whose deferred cluster attach hasn't fired yet fronts an
  // intentionally-asleep (scale-to-zero) vcluster and has no sessions by
  // construction (session create awaits the attach — see
  // deferred-boot in #platform/k8s). Probing it here would either WAKE it — the
  // very thing the deferral exists to prevent — or time out and surface as a
  // spurious "API server unreachable", which flips the web app's cluster gate
  // to the setup screen and blanks the workspace. Report ready without
  // probing; the real attach fires (and the caches push a fresh snapshot) when
  // the user actually creates a session. The CLI's `yaac cluster check` runs
  // in its own process where nothing is ever armed, so this never masks a real
  // failure there. Mirrors the same guard in sessions/list + projects/list.
  if (isDeferredClusterBootPending()) {
    return {
      ok: true,
      results: [{
        name: 'cluster', status: 'pass',
        detail: 'vcluster asleep (scale-to-zero) — wakes on first session',
      }],
    }
  }

  // 1. kubectl present
  try {
    await execFileAsync('kubectl', ['version', '--client', '--output', 'json'])
    add({ name: 'kubectl', status: 'pass', detail: 'installed' })
  } catch {
    add({
      name: 'kubectl', status: 'fail', detail: 'not found on PATH',
      fix: 'Install kubectl: https://kubernetes.io/docs/tasks/tools/',
    })
    return { ok: false, results }
  }

  // 2. cluster reachable. Nested, this first touch may be WAKING a
  // scaled-to-zero vcluster: the activator holds the TLS handshake while
  // the control plane boots (docs/vcluster-scale-to-zero.md), which
  // client-go's ~32s discovery timeout rides out — so give kubectl the
  // same headroom instead of killing it mid-wake at 10s.
  try {
    await execFileAsync('kubectl', ['version', '--output', 'json'], {
      timeout: env.nested ? 60_000 : 10_000,
    })
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
    const { stdout } = await execFileAsync('kubectl', ['get', 'nodes', '-o', 'json'])
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
    await execFileAsync('podman', ['--version'])
    add({ name: 'podman', status: 'pass', detail: 'installed (image build engine)' })
  } catch {
    add({
      name: 'podman', status: 'fail', detail: 'not found on PATH',
      fix: 'Install podman — yaac builds session images with it.',
    })
  }

  // 5. registry
  if (await registryReachable()) {
    add({ name: 'registry', status: 'pass', detail: `answering on ${registryHost()}` })
  } else {
    add({
      name: 'registry', status: 'fail',
      detail: `nothing answering on ${registryHost()}`,
      fix: 'The yaac server auto-starts a registry container on startup.\n'
        + 'Start it manually with:\n'
        + '  podman run -d --name yaac-registry -p 127.0.0.1:5001:5000 docker.io/library/registry:2',
    })
  }

  // 6. namespace
  try {
    await ensureNamespace()
    add({ name: 'namespace', status: 'pass', detail: `"${k8sNamespace()}" present` })
  } catch (err) {
    add({
      name: 'namespace', status: 'fail',
      detail: `cannot create namespace "${k8sNamespace()}" (${truncate(err)})`,
      fix: 'Check your kubeconfig context has admin rights on the cluster.',
    })
  }

  // 6a. PriorityClasses — cluster-scoped objects the pod builders name;
  // read-only, so it runs before the probe gates rather than behind them.
  add(await runPriorityClassCheck())

  // 6b–7. node fixups + gvisor + end-to-end probe (skipped when
  // prerequisites already failed)
  const PROBE_GATES = [
    'node-fixups', 'gvisor', 'probe', 'egress', 'datapath',
    'nested-mount', 'vap', 'runtime-stamp',
  ] as const
  const skipFrom = (from: (typeof PROBE_GATES)[number], detail: string): void => {
    for (const name of PROBE_GATES.slice(PROBE_GATES.indexOf(from))) {
      add({ name, status: 'skip', detail })
    }
  }
  if (results.some((r) => r.status === 'fail')) {
    skipFrom('node-fixups', 'skipped — fix the failures above first')
    return { ok: false, results }
  }
  add(await runNodeFixupsCheck())
  add(await runGvisorRuntimeCheck())

  // The e2e probe schedules a pod on the gvisor tier — with the
  // RuntimeClass missing it would sit Pending to its full timeout, so a
  // gvisor failure gates it.
  if (results.some((r) => r.status === 'fail')) {
    skipFrom('probe', 'skipped — fix the failures above first')
    return { ok: false, results }
  }
  // Inner yaac (a vcluster session, YAAC_NESTED=1): most remaining gates
  // probe machinery that deliberately does not exist inside a vcluster, so
  // they self-skip. The egress gate is among them: an inner session's egress
  // default-deny is enforced HOST-side (the host programs the redirect this
  // install claims — see docs/nested-containers.md), so it cannot be probed
  // in here; the OUTER cluster-check verifies it. vap has no in-vcluster
  // equivalent; vcluster-in-vcluster is refused. datapath is the exception —
  // this install owns half of it (its claim) and that half is checkable.
  if (env.nested) {
    add(await runEndToEndProbe())
    if (results.some((r) => r.status === 'fail')) {
      skipFrom('egress', 'skipped — fix the failures above first')
      return { ok: false, results }
    }
    add({ name: 'egress', status: 'skip', detail: 'skipped — nested yaac (inner-session egress is enforced host-side)' })
    // datapath IS checkable nested, in the inner install's own terms: its
    // claim-mode netd must be publishing, or the host has nothing to program
    // and inner sessions fall back to the outer proxy's allowlist alone.
    add(await runClaimDatapathCheck())
    for (const name of ['nested-mount', 'vap', 'runtime-stamp']) {
      add({ name, status: 'skip', detail: 'skipped — nested yaac (not applicable inside a vcluster)' })
    }
    // The stream relay IS checkable nested: the inner proxy's pod IP must
    // be dialable on the relay port (requires the outer yaac to project
    // the inner ingress rules — an outdated host yaac breaks this).
    add(await runNestedRelayCheck())
    return { ok: !results.some((r) => r.status === 'fail'), results }
  }

  // 8. The three pod-based probes, CONCURRENTLY. Each starts its own
  // gVisor sandbox, and serially they were most of the check's wall time
  // (~19s of a 71s `cluster setup`). They share nothing: distinct pod
  // names, distinct nonce files, and the policies the egress probe
  // applies are the ones the server applies anyway. The gvisor gate above
  // still runs first, so none of them can sit Pending to its timeout
  // waiting for a RuntimeClass that will never appear — which is the one
  // ordering that was ever load-bearing.
  const [probeResult, egressResult, nestedMountResult] = await Promise.all([
    runEndToEndProbe(),
    runNetworkPolicyProbe(),
    runNestedMountProbe(),
  ])
  add(probeResult)
  add(egressResult)

  // 9. datapath: Calico enforcing + netd up. (No top-level relay gate:
  // the server reaches the relay through a kubectl port-forward, the same
  // apiserver access the checks above already prove — there is no
  // cluster-shape wiring to verify.)
  add(await runDatapathCheck())

  // 10. nested userns-mount probe (warn-only: only nestedContainers
  // sessions need it — the tripwire for containerd versions where the
  // namespaced SYS_ADMIN grant does not unlock the mount family). Ran
  // above, alongside the other pod probes.
  add(nestedMountResult)

  // 10b. ValidatingAdmissionPolicy availability (warn-only: only
  // virtualCluster sessions need it — the synced-pod guard refuses
  // vcluster creation without it, fail-closed)
  add(await runVapAvailabilityCheck())

  // 11. runtime-stamp sweep (warn-only): every untrusted pod must carry a
  // gvisor-tier runtimeClassName.
  add(await runRuntimeStampSweep())

  return { ok: !results.some((r) => r.status === 'fail'), results }
}

const NODE_FIXUPS_FIX =
  'These fixups live in node/VM state and vanish on a node or VM restart. '
  + 'Re-apply them with: yaac cluster setup --repair'

/**
 * Warn-level detection for the node fixups `yaac cluster setup` applies. The
 * TasksMax / vm.min_free_kbytes / pids-limit fixups fail late — sessions die
 * mid-flight under subagent fan-out or virtiofs pressure — so sessions can
 * look healthy on a cluster that lost them to a restart. Probing is
 * kind-specific (node name == podman container name): a node that is not a
 * podman container self-skips.
 */
async function runNodeFixupsCheck(): Promise<CheckResult> {
  if (env.nested) {
    return {
      name: 'node-fixups', status: 'skip',
      detail: 'skipped — nested yaac (no podman-hosted node in here)',
    }
  }
  try {
    const { stdout } = await execFileAsync('kubectl', [
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
        const res = await execFileAsync('podman', ['exec', node, 'sh', '-c',
          `test -f ${NODE_TASKSMAX_CONF} && echo tasksmax=ok || echo tasksmax=missing; `
          + 'echo minfree=$(cat /proc/sys/vm/min_free_kbytes); '
          + `grep -q -- '--housekeeping-interval=${NODE_KUBELET_HOUSEKEEPING_INTERVAL}' `
          + `${NODE_KUBELET_FLAGS_ENV} && echo hk=ok || echo hk=missing`,
        ])
        report = res.stdout
      } catch {
        return {
          name: 'node-fixups', status: 'skip',
          detail: `node "${node}" is not a podman container — kind node fixups not applicable`,
        }
      }
      if (report.includes('tasksmax=missing')) missing.add('DefaultTasksMax (subagent fan-out)')
      const minfree = Number(/minfree=(\d+)/.exec(report)?.[1] ?? '0')
      if (minfree < NODE_MIN_FREE_KBYTES) missing.add('vm.min_free_kbytes (virtiofs I/O)')
      // Default-interval cAdvisor housekeeping burns whole kubelet cores
      // against gVisor sandboxes — see NODE_KUBELET_HOUSEKEEPING_INTERVAL.
      if (report.includes('hk=missing')) {
        missing.add('kubelet housekeeping-interval (cAdvisor stats CPU)')
      }
      const { stdout: pidsRaw } = await execFileAsync('podman', [
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
      detail: 'TasksMax, vm sysctls, kubelet housekeeping, and pids-limit in place',
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
 * Make the probe image available in the local registry (pulling/tagging
 * the busybox source once) and return its in-cluster ref — shared by every
 * probe that schedules a pod.
 */
async function ensureProbeImage(): Promise<string> {
  try {
    await execFileAsync('podman', ['image', 'inspect', PROBE_LOCAL_TAG])
  } catch {
    await execFileAsync('podman', ['pull', PROBE_SOURCE_IMAGE], { timeout: 120_000 })
    await execFileAsync('podman', ['tag', PROBE_SOURCE_IMAGE, PROBE_LOCAL_TAG])
  }
  return pushImageToRegistry(PROBE_LOCAL_TAG)
}

const GVISOR_PROBE_POD_NAME = 'yaac-cluster-check-gvisor'

const GVISOR_FIX =
  'Install the gVisor runtime with: yaac cluster setup --repair\n'
  + '(copies pinned runsc + containerd-shim-runsc-v1 onto the kind node, '
  + 'registers the runsc handlers in containerd, and applies the '
  + 'gvisor/gvisor-nested RuntimeClasses)'

const PRIORITY_CLASS_FIX =
  'Install the yaac PriorityClasses with: yaac cluster setup --repair\n'
  + '(the yaac server also re-applies them on every start)'

/**
 * The PriorityClass gate: every yaac pod but the session pods of a nested
 * install names one, and the apiserver REJECTS a pod naming a class it does
 * not have — for a session that means the Job applies fine and then hangs
 * with no pod, which is the failure this probe exists to name. Drifted
 * values (a class an older yaac installed with different numbers) only warn:
 * the pods still schedule, they just rank wrong.
 */
async function runPriorityClassCheck(): Promise<CheckResult> {
  const expected = buildPriorityClassManifests() as Array<{
    metadata: { name: string }
    value: number
    preemptionPolicy?: string
  }>
  try {
    const { stdout } = await execFileAsync('kubectl', ['get', 'priorityclass', '-o', 'json'])
    const live = new Map((JSON.parse(stdout) as {
      items: Array<{ metadata?: { name?: string }; value?: number; preemptionPolicy?: string }>
    }).items.map((c) => [c.metadata?.name ?? '', c]))

    const missing = expected.filter((e) => !live.has(e.metadata.name))
    if (missing.length > 0) {
      return {
        name: 'priority-classes', status: 'fail',
        detail: `missing PriorityClass(es): ${missing.map((e) => e.metadata.name).join(', ')}`,
        fix: PRIORITY_CLASS_FIX,
      }
    }
    const drifted = expected.filter((e) => {
      const c = live.get(e.metadata.name)
      // Kubernetes materializes the omitted policy as PreemptLowerPriority.
      const wantPolicy = e.preemptionPolicy ?? 'PreemptLowerPriority'
      return c?.value !== e.value || (c?.preemptionPolicy ?? 'PreemptLowerPriority') !== wantPolicy
    })
    if (drifted.length > 0) {
      return {
        name: 'priority-classes', status: 'warn',
        detail: `PriorityClass(es) differ from this yaac's: ${drifted.map((e) => e.metadata.name).join(', ')}`,
        fix: PRIORITY_CLASS_FIX,
      }
    }
    return {
      name: 'priority-classes', status: 'pass',
      detail: `${expected.map((e) => e.metadata.name).join(', ')} present`,
    }
  } catch (err) {
    return {
      name: 'priority-classes', status: 'fail',
      detail: `could not read PriorityClasses (${truncate(err)})`,
      fix: PRIORITY_CLASS_FIX,
    }
  }
}

/**
 * The gVisor gate: session pods run under `runtimeClassName: gvisor` with no
 * user namespace, so a cluster without the RuntimeClasses (or with a handler
 * that silently falls through to runc — which would run in-container root
 * UNSANDBOXED) cannot run sessions safely. Two halves: the RuntimeClasses
 * exist, and a pod on the gvisor class is provably inside the sentry —
 * gVisor's dmesg prints its own boot messages ("Starting gVisor..."), while a
 * runc pod sees the node kernel's ring buffer.
 */
async function runGvisorRuntimeCheck(): Promise<CheckResult> {
  if (env.nested) {
    return {
      name: 'gvisor', status: 'skip',
      detail: 'skipped — nested yaac (the host cluster owns the runtime)',
    }
  }
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'runtimeclass', '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    const present = new Set(stdout.trim().split(/\s+/).filter(Boolean))
    const missing = [RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED]
      .filter((n) => !present.has(n))
    if (missing.length > 0) {
      return {
        name: 'gvisor', status: 'fail',
        detail: `missing RuntimeClass(es): ${missing.join(', ')}`,
        fix: GVISOR_FIX,
      }
    }

    const imageRef = await ensureProbeImage()
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: GVISOR_PROBE_POD_NAME, namespace: k8sNamespace() },
      spec: {
        restartPolicy: 'Never',
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        containers: [{
          name: 'probe',
          image: imageRef,
          command: [
            'sh', '-c',
            'dmesg 2>/dev/null | grep -qi gvisor'
            + ' && echo GVISOR_SANDBOXED || echo GVISOR_NOT_SANDBOXED',
          ],
        }],
      },
    }, {
      timeoutMs: 90_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    if (phase !== 'Succeeded') {
      return {
        name: 'gvisor', status: 'fail',
        detail: `gvisor probe pod ended in phase ${phase} — runsc cannot run pods on this node`,
        fix: GVISOR_FIX,
      }
    }
    if (!logs.includes('GVISOR_SANDBOXED')) {
      return {
        name: 'gvisor', status: 'fail',
        detail: 'a pod on the gvisor RuntimeClass is not sentry-sandboxed — the handler is not actually runsc',
        fix: GVISOR_FIX,
      }
    }
    return {
      name: 'gvisor', status: 'pass',
      detail: 'RuntimeClasses present; gvisor pods run inside the sentry',
    }
  } catch (err) {
    return {
      name: 'gvisor', status: 'fail',
      detail: `gvisor probe errored (${truncate(err)})`,
      fix: GVISOR_FIX,
    }
  }
}

/**
 * Sandbox invariant sweep (warn-only): every pod hosting UNTRUSTED code
 * carries a gvisor-tier runtimeClassName. That's session pods (the
 * yaac.session-id label — stamped by the session builder, and propagated
 * verbatim for an inner yaac's synced sessions) and vcluster-synced tenant
 * pods (the syncer's managed-by label, which a tenant cannot suppress).
 * Trusted infra — proxy, registries, node-write pods, vcluster control
 * planes — deliberately stamps no runtime and runs on runc, so it is NOT
 * flagged. An unsandboxed match is either from a gVisor-less yaac era or
 * from a builder/values knob that lost the stamp. Warn rather than fail —
 * such pods still run, just without the sentry. Sweeps the install
 * namespace AND its per-vcluster child namespaces (`<ns>-vc-*`), where the
 * synced pods live.
 */
async function runRuntimeStampSweep(): Promise<CheckResult> {
  const ns = k8sNamespace()
  const sandboxed = new Set<string>([RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED])
  try {
    const { stdout } = await execFileAsync('kubectl', ['get', 'pods', '-A', '-o', 'json'])
    const items = (JSON.parse(stdout) as {
      items: Array<{
        metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
        spec?: { runtimeClassName?: string }
      }>
    }).items
    const inScope = (podNs: string | undefined): boolean =>
      podNs === ns || (podNs?.startsWith(`${ns}-vc-`) ?? false)
    const untrusted = (labels: Record<string, string> | undefined): boolean =>
      !!labels && (LABEL_SESSION_ID in labels || LABEL_VCLUSTER_MANAGED_BY in labels)
    const strays = items
      .filter((p) => inScope(p.metadata?.namespace)
        && untrusted(p.metadata?.labels)
        && !sandboxed.has(p.spec?.runtimeClassName ?? ''))
      .map((p) => `${p.metadata?.namespace ?? '?'}/${p.metadata?.name ?? '<unnamed>'}`)
    if (strays.length > 0) {
      const shown = strays.slice(0, 5).join(', ')
      return {
        name: 'runtime-stamp', status: 'warn',
        detail: `untrusted pod(s) without a gvisor-tier runtimeClassName: ${shown}`
          + (strays.length > 5 ? ` (+${strays.length - 5} more)` : ''),
        fix: 'These pods predate the gVisor migration (or bypassed the yaac '
          + 'builders). They keep running unsandboxed on the default '
          + 'runtime; recreate old sessions/vclusters to converge.',
      }
    }
    return {
      name: 'runtime-stamp', status: 'pass',
      detail: `every untrusted pod in "${ns}" and its vcluster namespaces is gvisor-sandboxed`,
    }
  } catch (err) {
    return {
      name: 'runtime-stamp', status: 'warn',
      detail: `could not sweep pods (${truncate(err)})`,
    }
  }
}

/**
 * The one check that exercises the full wiring: registry pull from inside
 * the cluster plus host-visible hostPath mounts. Failure modes map to the
 * two pieces of cluster setup yaac cannot do itself (containerd registry
 * config, node extraMounts).
 */
async function runEndToEndProbe(): Promise<CheckResult> {
  // The SHARED root: the probe writes here and mounts the same directory
  // into a pod, which is exactly the visibility contract that tier states.
  const dataDir = sharedRoot()
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
    const imageRef = await ensureProbeImage()

    const manifest = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: PROBE_POD_NAME, namespace: ns },
      spec: {
        restartPolicy: 'Never',
        // Mirror the session-pod containment (see buildSessionJobManifest):
        // a host pod carries the gvisor RuntimeClass (no userns), so the
        // probe proves hostPath reads/writes work through the gofer at the
        // session uid. runtimeClassSpec stamps nothing for an inner yaac.
        ...runtimeClassSpec({ inner: env.nested }),
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
    // Run to a terminal phase; image-pull errors and hostPath failures
    // both surface here.
    const { phase, logs } = await runPodToCompletion(manifest, {
      timeoutMs: 90_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    if (phase !== 'Succeeded') {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod ended in phase ${phase}`,
        fix: 'If the pod is stuck in ImagePullBackOff, the cluster cannot '
          + `pull from ${registryHost()} — wire the registry into the `
          + 'cluster (kind local-registry setup).\nIf it failed mounting '
          + `/probe, the node cannot see ${dataDir} — add an extraMounts `
          + 'entry for your home directory to the kind config.\n'
          + 'If it never got past Pending or failed with a runsc/'
          + 'RuntimeClass error, the gvisor runtime is broken — run '
          + '`yaac cluster setup --repair` (reinstalls pinned runsc).\n'
          + 'If it failed writing /probe/.cluster-check-write, uid '
          + `${sessionUid()} cannot write hostPath mounts — see the `
          + 'virtiofs ownership notes in docs/cluster-setup.md '
          + '("macOS: the podman machine").',
      }
    }
    if (logs.trim() !== nonce) {
      return {
        name: 'probe', status: 'fail',
        detail: 'probe pod read stale data from the hostPath mount',
        fix: `The node's view of ${dataDir} is not the host's — check the `
          + 'extraMounts entry in your kind config.',
      }
    }
    // The pod's write must round-trip to the host: this is the server-side
    // proof that a session's unprivileged uid can mutate hostPath mounts
    // (worktree, config dirs) — a read-only probe passes on clusters where
    // every session still dies on its first write.
    const written = await fs.readFile(writeFile, 'utf8').catch(() => null)
    if (written?.trim() !== 'ok') {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod's hostPath write (uid ${sessionUid()}) did not reach the host`,
        fix: 'Session pods write hostPath mounts as the yaac user, whose '
          + 'uid is baked in at image build time to match the server\'s. '
          + 'Rebuild session images (delete stale yaac-base/yaac-tools '
          + 'tags) and check the virtiofs ownership notes in '
          + 'docs/cluster-setup.md ("macOS: the podman machine").',
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
async function runNetworkPolicyProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    // The cluster-level egress lockdown: the session NetworkPolicy admits
    // world-ward egress ONLY to the node's netd listener range, so a pod
    // cannot address the internet directly and cannot dial the proxy's
    // transparent ports at all — those are admitted from the node CIDRs
    // only (netd's Envoy is the sole legitimate caller, and the sole
    // originator of PROXY-protocol preambles).
    const nodeCidrs = await nodeIpBlocks()
    await kubectlApply(buildSessionEgressNpManifest(nodeCidrs))
    await kubectlApply(buildProxyIngressNpManifest(nodeCidrs))
    const { stdout: rawIp } = await execFileAsync('kubectl', [
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
    // port directly. The block is on the pod's own egress (the session
    // policy's default-deny above), not the proxy ingress. A direct connect that
    // SUCCEEDS would let a pod inject a forged PROXY-protocol source and
    // impersonate another session. Absent proxy → skip this half (it deploys
    // lazily on the first session create).
    let proxyIp: string | null = null
    try {
      const { stdout } = await execFileAsync('kubectl', [
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

    const imageRef = await pushImageToRegistry(PROBE_LOCAL_TAG)
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: NETPOL_PROBE_POD_NAME,
        namespace: ns,
        labels: { [LABEL_SESSION_ID]: 'cluster-check-egress-probe' },
      },
      spec: {
        restartPolicy: 'Never',
        // The gvisor tier, like the real session pods this probe stands in
        // for — so the verdict also covers policy enforcement on netstack
        // traffic (the egress model is host-side/veth-level and must hold
        // regardless of the pod's runtime).
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        containers: [{
          name: 'probe',
          image: imageRef,
          command: [
            'sh', '-c',
            `nc -w 4 ${apiserverIp} 443 </dev/null && echo NP_REACHED || echo NP_BLOCKED${proxyCheck}`,
          ],
        }],
      },
    }, {
      timeoutMs: 60_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    if (phase !== 'Succeeded') {
      return {
        name: 'egress', status: 'fail',
        detail: `egress probe pod ended in phase ${phase}`,
        fix: KIND_SETUP_FIX,
      }
    }

    if (logs.includes('NP_REACHED')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod reached the apiserver directly — the CNI is not enforcing NetworkPolicy',
        fix: 'Session egress lockdown fails open without NetworkPolicy '
          + 'enforcement, leaving the proxy allowlist advisory. Re-run '
          + '`yaac cluster setup`, which installs Calico as the CNI and '
          + 'policy engine.',
      }
    }
    if (logs.includes('NP_PROXY_OPEN')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod dialed a proxy transparent port directly — the forgery lock is open, so a pod could impersonate another session',
        fix: 'The proxy-ingress NetworkPolicy must admit the transparent '
          + 'ports from the node CIDRs only, and the session-egress policy '
          + 'must admit nothing but the netd listener range. Restart the '
          + 'yaac server so ensureProxyResources re-applies both.',
      }
    }
    if (logs.includes('NP_BLOCKED')) {
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
      detail: `egress probe produced no verdict (logs: ${logs.trim().slice(0, 80) || 'empty'})`,
      fix: KIND_SETUP_FIX,
    }
  } catch (err) {
    return {
      name: 'egress', status: 'fail',
      detail: `egress probe errored (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    }
  }
}

/**
 * The nested datapath gate: this install's claim-mode netd must be
 * publishing what it wants redirected (features/cluster/redirect-claims.ts).
 *
 * There is no Calico half and no chain to inspect in here — a vcluster has
 * no nodes. What can go wrong is the claim: without one the host leaves this
 * install's session pods on the OUTER proxy, so they still reach the internet
 * but under the outer allowlist alone rather than inner ∩ outer. That is a
 * containment weakening a nested user cannot see from inside a session, so it
 * is reported rather than skipped.
 *
 * Absent is a WARN, not a fail: netd deploys with the proxy on first session
 * create, so a preflight in a fresh nested install legitimately finds
 * nothing. Deployed-but-unready is a FAIL — that is the silent case, where
 * the install believes it governs its sessions and does not.
 */
async function runClaimDatapathCheck(): Promise<CheckResult> {
  const { stdout: netd } = await execFileAsync('kubectl', [
    'get', 'daemonset', NETD_APP_NAME, '-n', k8sNamespace(),
    '-o', 'jsonpath={.status.numberReady}/{.status.desiredNumberScheduled}',
  ]).catch(() => ({ stdout: '' }))
  if (!netd.trim()) {
    return {
      name: 'datapath', status: 'warn',
      detail: `${NETD_APP_NAME} (claim mode) is not deployed yet — it lands with `
        + 'the inner proxy on first session create',
      fix: 'Until then this install claims nothing, so any pod it schedules is '
        + 'redirected to the OUTER proxy and governed by the outer allowlist alone.',
    }
  }
  const [ready, wanted] = netd.trim().split('/').map(Number)
  if (!(ready > 0) || ready !== wanted) {
    return {
      name: 'datapath', status: 'fail',
      detail: `${NETD_APP_NAME} (claim mode) is ${netd.trim()} ready — this install's `
        + 'sessions are redirected to the OUTER proxy, not this one',
      fix: 'The claim-mode netd publishes which pods this install wants '
        + 'redirected to its own proxy. Inspect with '
        + `\`kubectl -n ${k8sNamespace()} logs ds/${NETD_APP_NAME}\`.`,
    }
  }
  return {
    name: 'datapath', status: 'pass',
    detail: `${NETD_APP_NAME} (claim mode) ready — this install's redirect is claimed`,
  }
}

/**
 * `container: reason` for every not-ready netd container, from
 * `kubectl get pods -o json`. Unparseable input yields nothing — this only
 * ever enriches a failure that has already been decided.
 */
export function netdNotReadyContainers(podsJson: string): string[] {
  let parsed: {
    items?: Array<{
      status?: {
        containerStatuses?: Array<{
          name?: string
          ready?: boolean
          state?: Record<string, { reason?: string } | undefined>
        }>
      }
    }>
  }
  try {
    parsed = JSON.parse(podsJson || '{}') as typeof parsed
  } catch {
    return []
  }
  const out: string[] = []
  for (const pod of parsed.items ?? []) {
    for (const c of pod.status?.containerStatuses ?? []) {
      if (c.ready !== false || !c.name) continue
      const reason = Object.values(c.state ?? {})[0]?.reason ?? 'not ready'
      if (!out.includes(`${c.name}: ${reason}`)) out.push(`${c.name}: ${reason}`)
    }
  }
  return out
}

/**
 * The datapath gate: Calico must be enforcing, and netd must be up with
 * its redirect chain programmed.
 *
 * These are the two components session egress depends on, and they fail in
 * opposite directions — which is why both are checked. Calico missing means
 * NO policy enforcement, so the whole egress lockdown is advisory (the
 * behavioural half of that is the `egress` probe above). netd missing means
 * no redirect at all, which is fail-CLOSED: sessions simply lose egress.
 * A user staring at "every session lost the internet" needs to be told
 * which of the two it is.
 */
async function runDatapathCheck(): Promise<CheckResult> {
  try {
    const { stdout: calico } = await execFileAsync('kubectl', [
      'get', 'daemonset', 'calico-node', '-n', 'kube-system',
      '-o', 'jsonpath={.status.numberReady}/{.status.desiredNumberScheduled}',
    ])
    const [calicoReady, calicoWanted] = calico.trim().split('/').map(Number)
    if (!(calicoReady > 0) || calicoReady !== calicoWanted) {
      return {
        name: 'datapath', status: 'fail',
        detail: `calico-node is ${calico.trim()} ready — NetworkPolicy is not being enforced`,
        fix: 'Calico is the CNI and policy engine. Re-run `yaac cluster setup`, '
          + 'or inspect with `kubectl -n kube-system get pods -l k8s-app=calico-node`.',
      }
    }

    const { stdout: netd } = await execFileAsync('kubectl', [
      'get', 'daemonset', NETD_APP_NAME, '-n', k8sNamespace(),
      '-o', 'jsonpath={.status.numberReady}/{.status.desiredNumberScheduled}',
    ]).catch(() => ({ stdout: '' }))
    const [netdReady, netdWanted] = netd.trim().split('/').map(Number)
    if (!netd.trim() || !(netdReady > 0) || netdReady !== netdWanted) {
      const { stdout: pods } = await execFileAsync('kubectl', [
        'get', 'pods', '-n', k8sNamespace(), '-l', `app=${NETD_APP_NAME}`, '-o', 'json',
      ]).catch(() => ({ stdout: '' }))
      // Which container is unhealthy is the whole diagnosis here: netd's
      // readiness is Envoy's config ack, so a broken Envoy sidecar reads
      // exactly like a broken netd from the DaemonSet's counters alone.
      const blocked = netdNotReadyContainers(pods)
      return {
        name: 'datapath', status: 'fail',
        detail: netd.trim()
          ? `${NETD_APP_NAME} is ${netd.trim()} ready — session egress has no redirect`
            + (blocked.length ? ` (${blocked.join(', ')})` : '')
          : `${NETD_APP_NAME} is not deployed — session egress has no redirect`,
        fix: 'netd steers session egress into the proxy. `yaac cluster setup '
          + '--repair` re-applies it (the server also re-ensures it whenever it '
          + 'brings the proxy up). Inspect both containers with '
          + `\`kubectl -n ${k8sNamespace()} logs ds/${NETD_APP_NAME} -c netd\` and `
          + '`-c envoy`.',
      }
    }
    return {
      name: 'datapath', status: 'pass',
      detail: `calico-node and ${NETD_APP_NAME} ready (policy enforced, egress redirected)`,
    }
  } catch (err) {
    return {
      name: 'datapath', status: 'fail',
      detail: `could not query the datapath components (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    }
  }
}

const NESTED_PROBE_POD_NAME = 'yaac-cluster-check-nested'

/**
 * Warn-level gate for nestedContainers sessions (the rootful in-sandbox
 * engine). Reproduces the core sentry prerequisite the engine depends on,
 * under the real nested containment (gvisor-nested + the engine's in-sandbox
 * caps, no userns): the in-sandbox root must be able to `mount` (SYS_ADMIN
 * honored under the sentry) — every container start and `docker build` RUN
 * does overlay/proc/tmpfs mounts. A cluster whose runsc-nested handler is
 * broken (or absent) fails to start the pod at all. The richer prerequisites
 * the engine also needs — `allow-suid` for the `sudo`-started service, file
 * caps on the tmpfs graphroot — are verified end to end by the
 * nested-containers e2e;
 * this probe stays busybox-simple (no sudo/setcap in the probe image).
 */
async function runNestedMountProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const imageRef = await pushImageToRegistry(PROBE_LOCAL_TAG)
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: NESTED_PROBE_POD_NAME, namespace: ns },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        // The nested tier: gvisor-nested, no userns — the sentry is the
        // containment (mirrors buildSessionJobManifest's nested+gvisor path).
        runtimeClassName: RUNTIME_CLASS_GVISOR_NESTED,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{
          name: 'probe',
          image: imageRef,
          // Run as in-sandbox root (the rootful engine's shape) with its
          // in-sandbox caps; SYS_ADMIN is what mount() needs.
          securityContext: {
            runAsUser: 0,
            capabilities: { add: NESTED_ENGINE_CAPS },
          },
          command: [
            'sh', '-c',
            'mkdir -p /tmp/m && mount -t tmpfs none /tmp/m '
            + '&& echo NESTED_MOUNT_OK || echo NESTED_MOUNT_FAIL',
          ],
        }],
      },
    }, {
      timeoutMs: 60_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    if (phase !== 'Succeeded') {
      return {
        name: 'nested-mount', status: 'warn',
        detail: `nested probe pod ended in phase ${phase} — nestedContainers sessions unverified`,
        fix: NESTED_MOUNT_FIX,
      }
    }
    if (logs.includes('NESTED_MOUNT_OK')) {
      return {
        name: 'nested-mount', status: 'pass',
        detail: 'in-sandbox mount under gvisor-nested verified (nestedContainers ready)',
      }
    }
    return {
      name: 'nested-mount', status: 'warn',
      detail: 'mounting tmpfs under the gvisor-nested sentry failed'
        + ` (logs: ${logs.trim().slice(0, 80) || 'empty'})`,
      fix: NESTED_MOUNT_FIX,
    }
  } catch (err) {
    return {
      name: 'nested-mount', status: 'warn',
      detail: `nested sentry-mount probe errored (${truncate(err)})`,
      fix: NESTED_MOUNT_FIX,
    }
  }
}

const NESTED_MOUNT_FIX =
  'Only nestedContainers sessions are affected (docker build/run in-pod). '
  + 'The gvisor-nested runsc handler is broken or the sentry refuses the '
  + 'mount — run `yaac cluster setup --repair` to reinstall runsc and rewrite '
  + 'the handlers.'

/**
 * Warn-only gate for virtualCluster sessions: the synced-pod guard is a
 * ValidatingAdmissionPolicy, and vcluster creation refuses to proceed
 * without the API (fail-closed, no opt-out). Probes via `vapAvailable` —
 * the exact gate session-create applies — so check and gate cannot drift.
 */
async function runVapAvailabilityCheck(): Promise<CheckResult> {
  if (await vapAvailable()) {
    return {
      name: 'vap', status: 'pass',
      detail: 'ValidatingAdmissionPolicy API available (vcluster synced-pod guard)',
    }
  }
  return {
    name: 'vap', status: 'warn',
    detail: 'ValidatingAdmissionPolicy API unavailable',
    fix: 'Only virtualCluster sessions are affected — their synced-pod '
      + 'guard needs the ValidatingAdmissionPolicy API (kubernetes >= '
      + '1.30, enabled by default). vcluster creation fails closed '
      + 'without it.',
  }
}

/**
 * Nested: the relay is the inner proxy's pod IP on RELAY_PORT (a host pod
 * IP by syncer write-back). A dialable listener proves the inner proxy is
 * up AND the outer yaac projected the inner ingress rules (an outdated
 * host yaac drops the dial).
 */
async function runNestedRelayCheck(): Promise<CheckResult> {
  let ip: string | undefined
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'pods', '-n', k8sNamespace(), '-l', `app=${PROXY_APP_NAME}`, '-o', 'json',
    ])
    const list = JSON.parse(stdout) as { items?: Array<{ status?: { podIP?: string; phase?: string } }> }
    ip = list.items?.find((p) => p.status?.phase === 'Running')?.status?.podIP
      ?? list.items?.[0]?.status?.podIP
  } catch (err) {
    return {
      name: 'relay', status: 'warn',
      detail: `could not list the inner proxy pod (${truncate(err)}) — relay unverified`,
    }
  }
  if (!ip) {
    return {
      name: 'relay', status: 'warn',
      detail: 'inner proxy not deployed yet — relay unverified',
      fix: 'The inner proxy deploys on first session create; re-check afterwards.',
    }
  }
  const dialable = await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: ip, port: RELAY_PORT, timeout: 3_000 })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
    sock.on('error', () => resolve(false))
  })
  if (dialable) {
    return { name: 'relay', status: 'pass', detail: `inner proxy relay dialable at ${ip}:${RELAY_PORT}` }
  }
  return {
    name: 'relay', status: 'fail',
    detail: `inner proxy relay not dialable at ${ip}:${RELAY_PORT}`,
    fix: 'The OUTER yaac must be new enough to project the inner relay '
      + 'ingress rules (the same ordering contract as inner egress) — '
      + 'upgrade the host yaac, then recreate this session.',
  }
}

function truncate(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg.split('\n')[0]
}
