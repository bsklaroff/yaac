import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import {
  buildInnerProxyIngressNpManifest,
  buildInnerWorktreeIngressLockNpManifest,
  buildVclusterControlPlaneNpManifest,
  buildVclusterEgressFloorNpManifest,
} from './policy-manifests'
import { apiserverIpBlocks, nodeIpBlocks } from './cluster-cidrs'
import {
  dataDirHash,
  ensurePinnedBinary,
  execFileAsync,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  LABEL_WORKTREE_ID,
  LABEL_VCLUSTER,
  LABEL_VCLUSTER_DATA_DIR_HASH,
  LABEL_VCLUSTER_MANAGED_BY,
  LABEL_VCLUSTER_NAMESPACE,
  LABEL_VCLUSTER_SESSION_ID,
  PRIVILEGED_PSS_LABELS,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  VCLUSTER_API_PORT,
} from '#drivers/k8s/substrate'
import {
  ACTIVATOR_APP_NAME,
  buildActivatorVclusterRoleBindingManifest,
  buildActivatorVclusterRoleManifest,
  buildVclusterSleepEndpointSliceManifest,
  getActivatorPodIp,
} from './activator'
import { imageExists, pushImageToRegistry, registryHasTag, registryHost } from '#drivers/k8s/container'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import type { VirtualClusterStatus } from '#drivers/contract'

export const VCLUSTER_DIR = path.join(PACKAGE_ROOT, 'k8s', 'vcluster')

/**
 * Pinned Helm version yaac shells out to for `helm template`: used from
 * PATH when present, otherwise fetched once and cached under
 * ~/.cache/yaac/bin (ensurePinnedBinary — the pinned-binary convention).
 */
const HELM_VERSION = 'v3.16.4'

/** Ownership labels stamped on every vendored object (cleanup/GC keys). */

/**
 * Name prefix of the per-worktree ValidatingAdmissionPolicy gating
 * synced pods. Per-worktree (prefix + vcluster name), not a shared
 * static policy with per-worktree params: VAP paramRef resolution is
 * broken on current kind/k8s 1.36 ("no params found" even for a
 * minimal textbook policy), and the only parameter was one string —
 * the allowed hostPath prefix — which inlines into the CEL just fine.
 */
export const VCLUSTER_POD_GUARD_POLICY = 'yaac-vcluster-pod-guard'

/** Per-worktree pod-guard policy/binding name. */
export function vclusterGuardName(name: string): string {
  return `${VCLUSTER_POD_GUARD_POLICY}-${name}`
}

/** Escape a string for embedding in a single-quoted CEL literal. */
function celString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Per-worktree vcluster name: `yvc-<sid8>`. Eight hex chars of the
 * worktree UUID — short enough that every chart-derived name
 * (vc-config-<name>, ClusterRole <name>-v-<ns>, …) stays under the
 * 63-char label cap, unique enough across the handful of coexisting
 * vclusters the cap allows.
 */
export function vclusterName(worktreeId: string): string {
  const sid8 = worktreeId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  return `yvc-${sid8}`
}

/** Secret the syncer writes the exported kubeconfig into. */
export function vclusterKubeconfigSecretName(name: string): string {
  return `vc-${name}`
}

/**
 * Dedicated host namespace for one worktree's vcluster. vcluster enforces
 * one vcluster per host namespace (it owns the namespace's resource-name
 * space), so each worktree gets its own `<install-ns>-vc-<sid8>` — this is
 * what lets two virtualCluster worktrees run in parallel. Prefixed with
 * the install namespace so coexisting installs don't collide and so e2e
 * per-run namespaces (yaac-test-*) sweep these too.
 */
export function vclusterNamespace(name: string): string {
  return `${k8sNamespace()}-vc-${name.replace(/^yvc-/, '')}`
}

export interface VclusterRenderParams {
  worktreeId: string
}

let helmPathCache: string | null = null
let chartVersionCache: string | null = null

/** Read the pinned chart version (k8s/vcluster/VERSION). */
async function chartVersion(): Promise<string> {
  if (chartVersionCache === null) {
    chartVersionCache = (await fs.readFile(path.join(VCLUSTER_DIR, 'VERSION'), 'utf8')).trim()
  }
  return chartVersionCache
}

/**
 * Resolve a `helm` binary, preferring one on PATH and otherwise fetching
 * the pinned release once into ~/.cache/yaac/bin (ensurePinnedBinary,
 * the pinned-binary convention). yaac only needs helm for `helm template`
 * against the vendored chart tarball (offline); the binary fetch is the
 * one network step, cached across runs.
 */
export async function ensureHelm(): Promise<string> {
  if (helmPathCache) return helmPathCache
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  helmPathCache = await ensurePinnedBinary({
    bin: 'helm',
    version: HELM_VERSION,
    url: `https://get.helm.sh/helm-${HELM_VERSION}-${plat}-${arch}.tar.gz`,
    // The release tarball nests the binary in a platform subdir.
    tarMember: `${plat}-${arch}/helm`,
    stripComponents: 1,
  }, {
    run: (file, args, opts) => execFileAsync(file, args, opts),
    homedir: () => os.homedir(),
    fileExists: (p) => fs.access(p).then(() => true).catch(() => false),
  })
  return helmPathCache
}

/**
 * Add the yaac ownership labels to every object in a multi-doc manifest
 * stream. The chart has no global-labels knob (only globalMetadata
 * annotations), so this is the single post-render step — everything else
 * (names, namespace, registry, API host, the Service shape) is
 * expressed via values + `--set`. `lineWidth: 0` keeps the config
 * Secret's long base64 scalar on one line.
 */
export function addYaacLabels(
  manifestYaml: string,
  labels: Record<string, string>,
): string {
  const out: string[] = []
  for (const doc of YAML.parseAllDocuments(manifestYaml)) {
    const obj = doc.toJS() as { kind?: string; metadata?: { labels?: Record<string, string> } } | null
    if (!obj || typeof obj !== 'object' || !obj.kind) continue
    obj.metadata = obj.metadata ?? {}
    obj.metadata.labels = { ...(obj.metadata.labels ?? {}), ...labels }
    out.push(YAML.stringify(obj, { lineWidth: 0 }))
  }
  return out.join('---\n')
}

/**
 * Strip `spec.replicas` from the control-plane Deployment so yaac owns
 * the replica count out-of-band (scale-to-zero — see
 * docs/vcluster-scale-to-zero.md). The chart renders `replicas: 1`; with
 * the field absent from the applied config the first apply defaults to 1
 * (the create-time boot), `kubectl scale` sets 0/1 afterwards, and later
 * re-applies (server restart, re-ensure) never stomp the live value —
 * the field is absent from both the config and the last-applied state.
 */
export function stripControlPlaneReplicas(manifestYaml: string, name: string): string {
  const out: string[] = []
  for (const doc of YAML.parseAllDocuments(manifestYaml)) {
    const obj = doc.toJS() as {
      kind?: string
      metadata?: { name?: string }
      spec?: { replicas?: number }
    } | null
    if (!obj || typeof obj !== 'object' || !obj.kind) continue
    if (obj.kind === 'Deployment' && obj.metadata?.name === name && obj.spec) {
      delete obj.spec.replicas
    }
    out.push(YAML.stringify(obj, { lineWidth: 0 }))
  }
  return out.join('---\n')
}

/**
 * Render one worktree's vcluster manifests by running `helm template`
 * against the vendored chart tarball (offline) with the per-worktree
 * values passed as `--set` overrides, then stamping the yaac ownership
 * labels. No vendored rendered manifest, no placeholder substitution —
 * the chart's own logic runs each time, so a chart bump only needs
 * `scripts/fetch-vcluster-chart.sh` (re-vendor the tarball). The
 * control-plane pod stamps no runtime (trusted infra on runc — see
 * gvisor.ts); synced pods get their gvisor runtime from the syncer via
 * `sync.toHost.pods.runtimeClassName` in values.yaml, so no post-render
 * runtime stamping is needed.
 */
export async function renderVclusterManifests(p: VclusterRenderParams): Promise<string> {
  const helm = await ensureHelm()
  const name = vclusterName(p.worktreeId)
  // The worktree pod reaches the API by its in-cluster service-DNS name,
  // resolved through the proxy's split-horizon DNS to the live (allocator-
  // assigned) ClusterIP — so the serving-cert SAN and the exported kubeconfig
  // server use that name, and the Service's ClusterIP is no longer pinned. A
  // full `.svc.cluster.local` FQDN: the proxy forwards only `.cluster.local` to
  // CoreDNS (a bare `.svc` would be sinkholed to avoid a DNS-exfil channel).
  const apiHost = `${name}.${vclusterNamespace(name)}.svc.cluster.local`
  const chart = path.join(VCLUSTER_DIR, `vcluster-${await chartVersion()}.tgz`)
  const { stdout } = await execFileAsync(helm, [
    'template', name, chart,
    '--namespace', vclusterNamespace(name),
    '--values', path.join(VCLUSTER_DIR, 'values.yaml'),
    // Per-worktree overrides. --set-string so an all-digits registry host
    // is never coerced to a number.
    '--set-string', `controlPlane.advanced.defaultImageRegistry=${registryHost()}`,
    '--set-string', `controlPlane.proxy.extraSANs[0]=${apiHost}`,
    '--set-string', `exportKubeConfig.server=https://${apiHost}:${VCLUSTER_API_PORT}`,
  ], { maxBuffer: 16 * 1024 * 1024 })
  return stripControlPlaneReplicas(
    addYaacLabels(stdout, vclusterLabels(name, p.worktreeId)),
    name,
  )
}

interface VclusterImageEntry {
  upstream: string
  localTag: string
}

/**
 * Mirror the pinned vcluster image set (k8s/vcluster/images.json) into
 * the local registry — the closed set of images a vcluster can ever
 * schedule (defaultImageRegistry rewrites every ref onto the local
 * registry, so nothing pulls upstream at pod-create time).
 */
export async function ensureVclusterImages(
  requirePrebuilt = testEnv.requirePrebuiltImages,
): Promise<void> {
  const raw = await fs.readFile(path.join(VCLUSTER_DIR, 'images.json'), 'utf8')
  const { images } = JSON.parse(raw) as { images: VclusterImageEntry[] }
  for (const { upstream, localTag } of images) {
    if (await registryHasTag(localTag)) continue
    if (!await imageExists(localTag)) {
      if (requirePrebuilt) {
        throw new Error(
          `vcluster image ${localTag} is missing. ` +
          'Restart the test run so the global setup can mirror it.',
        )
      }
      await execFileAsync('podman', ['pull', upstream], { timeout: 600_000 })
      await execFileAsync('podman', ['tag', upstream, localTag])
    }
    await pushImageToRegistry(localTag)
  }
}

/** Ownership labels stamped on every object a vcluster owns (GC keys). */
export function vclusterLabels(name: string, worktreeId: string): Record<string, string> {
  return {
    [LABEL_VCLUSTER]: name,
    [LABEL_VCLUSTER_SESSION_ID]: worktreeId,
    [LABEL_VCLUSTER_DATA_DIR_HASH]: dataDirHash(),
  }
}

/**
 * The vcluster's dedicated host namespace. Labeled for GC: the orphan
 * reconcile lists these namespaces (the top-level object) and deletes
 * the whole namespace, so a single delete tears the vcluster down.
 */
export function buildVclusterNamespaceManifest(
  name: string,
  worktreeId: string,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: vclusterNamespace(name),
      // LABEL_VCLUSTER_NAMESPACE is what lets plain NetworkPolicy name
      // these namespaces as peers: a namespaceSelector matches labels, so
      // cross-namespace rules key on this rather than on a name pattern.
      //
      // Privileged PSS alongside it: this namespace holds synced tenant
      // pods, whose shape is decided by the vcluster's own admission guard
      // rather than by the host default. On an adopted cluster a
      // baseline/restricted default would reject them here instead —
      // loudly, but for the wrong reason.
      labels: {
        ...vclusterLabels(name, worktreeId),
        [LABEL_VCLUSTER_NAMESPACE]: 'true',
        ...PRIVILEGED_PSS_LABELS,
      },
    },
  }
}

// CEL fragments for the pod guard. Composed per container list so the
// same rules cover containers, initContainers, and ephemeralContainers
// (separate variables — CEL list concat across distinct schema types
// does not type-check).
//
// NET_BIND_SERVICE is the one cap admitted without the sentry tier: it only
// permits binding <1024 ports inside the pod's OWN netns — no node authority
// — and vcluster's deployed CoreDNS carries it (vestigially; it listens on
// 1053). Everything else is gated on the gvisor runtime tier.
const NO_CAPS_OR_APE = (cs: string): string =>
  `${cs}.all(c, !has(c.securityContext) || (`
  + '(!has(c.securityContext.capabilities) || !has(c.securityContext.capabilities.add) || '
  + "c.securityContext.capabilities.add.all(cap, cap == 'NET_BIND_SERVICE'))"
  + ' && !(has(c.securityContext.allowPrivilegeEscalation) && c.securityContext.allowPrivilegeEscalation)))'

const NOT_PRIVILEGED = (cs: string): string =>
  `${cs}.all(c, !has(c.securityContext) || !(has(c.securityContext.privileged) && c.securityContext.privileged))`

const NO_UNCONFINED = (cs: string): string =>
  `${cs}.all(c, !has(c.securityContext) || !(has(c.securityContext.seccompProfile) && c.securityContext.seccompProfile.type == 'Unconfined'))`

/**
 * The per-worktree synced-pod guard: a ValidatingAdmissionPolicy whose
 * binding (below) scopes it to one vcluster's synced pods. The allowed
 * hostPath prefix is inlined as a CEL literal (see
 * VCLUSTER_POD_GUARD_POLICY for why no paramRef).
 *
 * A capability grant is safe only behind a containment boundary: a synced
 * pod could otherwise combine the default `hostUsers: true` with
 * `capabilities.add` (or allowPrivilegeEscalation) + Unconfined into real
 * node authority — NET_ADMIN under host users would let a pod rewrite host
 * netfilter. The boundary here is the gVisor sentry: the syncer stamps
 * `gvisor` on every synced pod (values.yaml), and in-sandbox caps carry no
 * host authority. So:
 *   - hostPath volumes only under the worktree's nested data dir (param)
 *   - no hostNetwork / hostPID / hostIPC / hostPorts / privileged
 *   - capabilities.add or an explicit allowPrivilegeEscalation: true require
 *     the gvisor runtime tier; seccomp Unconfined is denied outright
 *
 * CEL nil-handling: an absent allowPrivilegeEscalation defaults to TRUE at
 * runtime, but the rule matches only an explicit `true` — nil with no added
 * caps is the stock pod default (file caps cannot exceed the bounding set),
 * and `capabilities.add` is the load-bearing gate.
 *
 * The rule admits the nested-worktree securityContext (the rootful engine's
 * in-sandbox capability adds under the gvisor tier) that an inner yaac's
 * synced worktree pods carry.
 */
export function buildVclusterPodGuardPolicyManifest(
  name: string,
  worktreeId: string,
  allowedHostPathPrefix: string,
): Record<string, unknown> {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: {
      name: vclusterGuardName(name),
      labels: vclusterLabels(name, worktreeId),
    },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: {
        resourceRules: [{
          apiGroups: [''],
          apiVersions: ['v1'],
          operations: ['CREATE', 'UPDATE'],
          resources: ['pods'],
        }],
      },
      variables: [
        {
          name: 'cs',
          expression:
            'object.spec.containers + (has(object.spec.initContainers) ? object.spec.initContainers : [])',
        },
        {
          name: 'ecs',
          expression:
            'has(object.spec.ephemeralContainers) ? object.spec.ephemeralContainers : []',
        },
        {
          // The gVisor sentry is the containment boundary for caps —
          // in-sandbox caps grant no host authority. The syncer stamps one
          // of these on every synced pod.
          name: 'sandboxed',
          expression:
            'has(object.spec.runtimeClassName) && '
            + `(object.spec.runtimeClassName == '${RUNTIME_CLASS_GVISOR}' `
            + `|| object.spec.runtimeClassName == '${RUNTIME_CLASS_GVISOR_NESTED}')`,
        },
      ],
      validations: [
        {
          expression:
            '!has(object.spec.volumes) || object.spec.volumes.all(v, '
            + `!has(v.hostPath) || v.hostPath.path.startsWith('${celString(allowedHostPathPrefix)}'))`,
          message: 'hostPath volumes must stay under the session nested data dir',
        },
        {
          expression:
            '!(has(object.spec.hostNetwork) && object.spec.hostNetwork)'
            + ' && !(has(object.spec.hostPID) && object.spec.hostPID)'
            + ' && !(has(object.spec.hostIPC) && object.spec.hostIPC)',
          message: 'hostNetwork/hostPID/hostIPC are not allowed for vcluster pods',
        },
        {
          expression:
            'variables.cs.all(c, !has(c.ports) || c.ports.all(p, !has(p.hostPort) || p.hostPort == 0))',
          message: 'hostPorts are not allowed for vcluster pods',
        },
        {
          expression: `${NOT_PRIVILEGED('variables.cs')} && ${NOT_PRIVILEGED('variables.ecs')}`,
          message: 'privileged containers are not allowed for vcluster pods',
        },
        {
          // The caps rule. Evaluated across containers AND initContainers
          // (variables.cs) so a cap grant can't ride in on an init
          // container. A capability grant needs the gvisor sentry tier.
          expression:
            'variables.sandboxed '
            + `|| (${NO_CAPS_OR_APE('variables.cs')} && ${NO_CAPS_OR_APE('variables.ecs')})`,
          message:
            'capabilities.add (beyond NET_BIND_SERVICE) / allowPrivilegeEscalation '
            + 'require the gvisor runtime tier',
        },
        {
          expression:
            '!(has(object.spec.securityContext) && has(object.spec.securityContext.seccompProfile)'
            + " && object.spec.securityContext.seccompProfile.type == 'Unconfined')"
            + ` && ${NO_UNCONFINED('variables.cs')} && ${NO_UNCONFINED('variables.ecs')}`,
          message: 'seccompProfile Unconfined is not allowed for vcluster pods',
        },
      ],
    },
  }
}

/**
 * Per-worktree binding: scopes this vcluster's guard to its synced pods
 * via the syncer's managed-by label, restricted to the vcluster's own
 * host namespace.
 */
export function buildVclusterPodGuardBindingManifest(
  name: string,
  worktreeId: string,
): Record<string, unknown> {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicyBinding',
    metadata: {
      name: vclusterGuardName(name),
      labels: vclusterLabels(name, worktreeId),
    },
    spec: {
      policyName: vclusterGuardName(name),
      validationActions: ['Deny'],
      matchResources: {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': vclusterNamespace(name) },
        },
        objectSelector: {
          matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: name },
        },
      },
    },
  }
}

/**
 * Per-worktree NetworkPolicy `yaac-vc-<sid8>` for the SESSION pod. The
 * worktree pod lives in the install namespace, but its vcluster API and
 * synced pods are in the vcluster's own namespace — so the egress peers
 * are CROSS-NAMESPACE (namespaceSelector + podSelector). It admits the
 * worktree pod to reach ITS OWN vcluster API on 8443 and its synced pods
 * (managed-by label; the OSS syncer cannot stamp yaac.worktree-id, see
 * values.yaml). The SOLE egress hole for these flows: NetworkPolicy
 * unions allow rules, so this punches a per-worktree hole through the
 * install-wide worktree-egress policy's default-deny (which has no
 * in-cluster 8443 allowance — a blanket rule there would open every
 * worktree's vcluster API to every other worktree).
 */
export function buildVclusterWorktreeNetworkPolicyManifest(
  name: string,
  worktreeId: string,
): Record<string, unknown> {
  const vcNsSelector = {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': vclusterNamespace(name) } },
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `yaac-vc-${name.replace(/^yvc-/, '')}`,
      namespace: k8sNamespace(),
      labels: vclusterLabels(name, worktreeId),
    },
    spec: {
      podSelector: { matchLabels: { [LABEL_WORKTREE_ID]: worktreeId } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ ...vcNsSelector, podSelector: { matchLabels: { app: 'vcluster', release: name } } }],
          ports: [{ protocol: 'TCP', port: VCLUSTER_API_PORT }],
        },
        {
          to: [{ ...vcNsSelector, podSelector: { matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: name } } }],
        },
        {
          // While the vcluster is asleep its API ClusterIP is intercepted
          // by the activator (same install namespace as the worktree pod).
          // NetworkPolicy is evaluated on the post-DNAT destination, so
          // the wake-triggering first touch needs its own allowance — the
          // rule above matches only the real control-plane pod.
          to: [{ podSelector: { matchLabels: { app: ACTIVATOR_APP_NAME } } }],
          ports: [{ protocol: 'TCP', port: VCLUSTER_API_PORT }],
        },
      ],
    },
  }
}

/** True when the cluster serves the ValidatingAdmissionPolicy API. */
export async function vapAvailable(): Promise<boolean> {
  try {
    await kubectlWithRetry(
      ['get', 'validatingadmissionpolicies', '-o', 'name'],
      { maxAttempts: 1, timeout: 15_000 },
    )
    return true
  } catch {
    return false
  }
}

/**
 * Grace window protecting a freshly-created vcluster from the orphan GC.
 * createWorktree stands the vcluster up BEFORE the worktree Job (the Job
 * mounts the vcluster's kubeconfig, so the vcluster must exist first),
 * which leaves a window where the vcluster carries a worktree-id that no
 * live pod/Job advertises yet. The reconcile tick must not reap it
 * during that window — sized to comfortably cover a cold worktree create
 * (image pulls + vcluster rollout + worktree).
 */
export const VCLUSTER_ORPHAN_GRACE_MS = 15 * 60 * 1000

export interface EnsureVclusterParams {
  worktreeId: string
  /** VAP param: the only hostPath prefix synced pods may mount. */
  allowedHostPathPrefix: string
  /** Progress hook (worktree-create's emit); called for slow waits. */
  onProgress?: (message: string) => void
}

export interface WaitForVclusterNamespaceGoneOpts {
  timeoutMs?: number
  /** Poll interval; injectable so tests don't sleep real seconds. */
  pollMs?: number
  /** Invoked once, on the first probe that finds the namespace Terminating. */
  onWaiting?: () => void
}

/**
 * Wait for a Terminating same-named vcluster namespace to disappear.
 *
 * Teardown deletes the namespace with `--wait=false`, and a restart
 * re-ensures the SAME name seconds later (worktree ids are stable across
 * restarts) while termination — pod grace periods, endpoint
 * cleanup, finalizers — takes minutes. Applying into the Terminating
 * namespace does not fail: every old object still exists, so each apply
 * lands as a PATCH on a doomed object (only CREATE is blocked in a
 * terminating namespace) and the kubeconfig wait reads the doomed
 * Secret — then termination completes and silently sweeps the "new"
 * vcluster. The namespace being fully gone is the only safe re-create
 * point.
 *
 * Returns immediately when the namespace is absent, or present without a
 * deletionTimestamp (a live vcluster — the caller's applies are the
 * normal ensure-over-existing path).
 */
export async function waitForVclusterNamespaceGone(
  name: string,
  opts: WaitForVclusterNamespaceGoneOpts = {},
): Promise<void> {
  const { timeoutMs = 10 * 60 * 1000, pollMs = 2000, onWaiting } = opts
  const vcNs = vclusterNamespace(name)
  const deadline = Date.now() + timeoutMs
  let waited = false
  for (;;) {
    const ns = await kubectlGetJson<{ metadata?: { deletionTimestamp?: string } }>([
      'get', 'namespace', vcNs,
    ])
    if (!ns || !ns.metadata?.deletionTimestamp) return
    if (!waited) {
      waited = true
      onWaiting?.()
    }
    if (Date.now() > deadline) {
      throw new Error(
        `vcluster namespace ${vcNs} is still Terminating after ${timeoutMs}ms — `
        + `the previous teardown is stuck; check: kubectl get namespace ${vcNs} -o yaml`,
      )
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/**
 * Stand up one worktree's vcluster: VAP guard first (no synced pod may
 * ever be admitted unguarded), then the confinement policies, then the
 * chart. Fail-closed on a missing VAP API — synced-pod containment
 * rests on the guard, so there is no opt-out.
 *
 * Returns whether the control plane was freshly created by this call —
 * the caller's born-at-zero sleep applies only then (re-ensuring an
 * existing vcluster must never discard its state by re-sleeping it).
 */
export async function ensureWorktreeVcluster(
  p: EnsureVclusterParams,
): Promise<{ freshlyCreated: boolean }> {
  const name = vclusterName(p.worktreeId)
  const vcNs = vclusterNamespace(name)

  // VAP guard BEFORE the syncer exists: the first synced pod (CoreDNS)
  // appears within seconds of the control plane going ready, and the
  // guard is the only thing confining synced pods — so a missing API is
  // fatal, never a downgrade-to-unguarded.
  if (!await vapAvailable()) {
    throw new Error(
      'virtualCluster requires the ValidatingAdmissionPolicy API '
      + '(kubernetes >= 1.30) — without it synced pods would be unguarded.',
    )
  }

  // A same-named namespace still Terminating means a previous vcluster's
  // teardown hasn't finished (the restart flow re-creates the same name
  // seconds after cleanup). Applying below would "succeed" as patches on
  // doomed objects and the whole vcluster would vanish when termination
  // completes — so block until the namespace is actually gone.
  await waitForVclusterNamespaceGone(name, {
    onWaiting: () => p.onProgress?.(
      'Waiting for the previous virtual cluster to finish terminating...',
    ),
  })

  // Freshness probe for the born-at-zero sleep decision: a pre-existing
  // control-plane Deployment means this is a re-ensure over a live
  // vcluster, which must not be re-slept (its state.db is real).
  const priorDeployment = await kubectlGetJson<{ metadata?: { name?: string } }>([
    'get', 'deployment', name, '-n', vcNs,
  ])

  // The vcluster's own namespace first (vcluster owns one per namespace).
  await kubectlApply(buildVclusterNamespaceManifest(name, p.worktreeId))

  await kubectlApply(
    buildVclusterPodGuardPolicyManifest(name, p.worktreeId, p.allowedHostPathPrefix),
  )
  await kubectlApply(buildVclusterPodGuardBindingManifest(name, p.worktreeId))

  // The activator's per-vcluster grant (scale/certs/slice — see
  // buildActivatorVclusterRoleManifest), scoped to this namespace and
  // swept with it.
  await kubectlApply(buildActivatorVclusterRoleManifest(name, vcNs, vclusterLabels(name, p.worktreeId)))
  await kubectlApply(buildActivatorVclusterRoleBindingManifest(vcNs, vclusterLabels(name, p.worktreeId)))

  // The API Service's ClusterIP is allocator-assigned (no longer pinned), so
  // there is no immutable-field migration: the chart apply below creates it
  // once and never needs to recreate it.

  // Confinement BEFORE the control plane exists: Calico fails closed, so the
  // synced-pod egress floor must be in place before the syncer creates its first
  // host pod (CoreDNS appears within seconds) — otherwise a pod with no policy
  // selecting it would get default-ALLOW egress, a cold-start window to raw
  // world. The worktree policy lives in the install namespace (it selects the
  // worktree pod); the synced-pod egress floor (default-deny + world→the node's
  // listener range + intracluster) and the control-plane policy live in the
  // vcluster namespace. Both are STATIC per-vcluster NetworkPolicies seeded
  // here and torn down with the namespace — nothing deletes them in between,
  // so the server reconcile does not re-assert them. The redirect itself is
  // not a policy object at all: netd programs it per synced-pod veth from
  // what it observes on the node, so creating a vcluster adds no listener.
  const [nodeCidrs, apiserverCidrs] = await Promise.all([nodeIpBlocks(), apiserverIpBlocks()])
  await kubectlApply(buildVclusterWorktreeNetworkPolicyManifest(name, p.worktreeId))
  await kubectlApply(buildVclusterEgressFloorNpManifest(vcNs, name, nodeCidrs))
  await kubectlApply(buildVclusterControlPlaneNpManifest(
    vcNs, name, vclusterLabels(name, p.worktreeId), apiserverCidrs,
  ))
  // The inner locks are static per vcluster — they name only the vcluster
  // and its owning worktree — so they ship with the namespace instead of
  // being projected on a reconcile pass. netd discovers inner proxies
  // itself, so no policy object here is dynamic.
  await kubectlApply(buildInnerProxyIngressNpManifest(vcNs, name, p.worktreeId, nodeCidrs))
  await kubectlApply(buildInnerWorktreeIngressLockNpManifest(vcNs, name))
  await kubectlWithRetry(['apply', '-f', '-'], {
    input: await renderVclusterManifests({ worktreeId: p.worktreeId }),
  })
  return { freshlyCreated: priorDeployment === null }
}

/**
 * Wait for the syncer to publish the exported kubeconfig (Secret
 * vc-<name>, key `config`) and return it decoded. Already pointed at
 * https://<api-svc-dns>:8443 via exportKubeConfig.server — no rewrite.
 */
export async function waitForVclusterKubeconfig(
  name: string,
  timeoutMs = 360_000,
): Promise<string> {
  const vcNs = vclusterNamespace(name)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const secret = await kubectlGetJson<{ data?: Record<string, string> }>([
      'get', 'secret', vclusterKubeconfigSecretName(name), '-n', vcNs,
    ])
    const encoded = secret?.data?.config
    if (encoded) return Buffer.from(encoded, 'base64').toString('utf8')
    if (Date.now() > deadline) {
      throw new Error(
        `vcluster ${name} did not publish its kubeconfig within ${timeoutMs}ms — `
        + `check: kubectl logs deploy/${name} -n ${vcNs}`,
      )
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

export interface SleepVclusterOpts {
  /** Poll interval for the control-plane-gone wait (tests inject). */
  pollMs?: number
  timeoutMs?: number
}

/**
 * Scale a freshly-booted, UNUSED vcluster to zero (born-at-zero — see
 * docs/vcluster-scale-to-zero.md). Reclaims the whole idle control
 * plane (~330–390 MB) plus its CoreDNS pod until something touches the
 * API, at which point the activator cold-starts it back.
 *
 * The `/data` emptyDir (kine's state.db) dies with the pod; on wake the
 * control plane re-bootstraps a clean vcluster from the PKI persisted in
 * the `<name>-certs` Secret, so the already-exported kubeconfig stays
 * valid. That makes one rule load-bearing: only a vcluster nothing has
 * written to may be slept — anything written between boot and sleep is
 * silently lost. The create flow guarantees that by sleeping only a
 * `freshlyCreated` vcluster, immediately after the kubeconfig export.
 *
 * Steps, in order:
 *  1. Intercept the API Service (EndpointSlice → the activator) BEFORE
 *     scaling down, so no client ever sees a black-hole ClusterIP — a
 *     touch during the scale-down lands on the activator and simply
 *     wakes the vcluster again.
 *  2. Scale the control plane to 0 and wait for its pod to terminate
 *     (the syncer must be gone before step 3 so it can't recreate
 *     anything).
 *  3. Delete the vcluster's synced host pods (CoreDNS). The syncer is
 *     down and cannot GC them — left alone the synced CoreDNS pod runs
 *     forever, burning the memory the sleep was meant to reclaim. They
 *     are plain Pods (no host owner), so nothing recreates them; the
 *     wake's fresh bootstrap recreates virtual + host CoreDNS from
 *     scratch.
 */
export async function sleepVcluster(
  name: string,
  worktreeId: string,
  opts: SleepVclusterOpts = {},
): Promise<void> {
  const { pollMs = 1000, timeoutMs = 120_000 } = opts
  const vcNs = vclusterNamespace(name)

  // The activator serves the vcluster's identity from its certs Secret —
  // without it (or a live activator pod) an asleep vcluster would be
  // unreachable, so fail the sleep instead (the vcluster just stays up).
  const certs = await kubectlGetJson<{ metadata?: { name?: string } }>([
    'get', 'secret', `${name}-certs`, '-n', vcNs,
  ])
  if (!certs) throw new Error(`vcluster ${name} has no ${name}-certs secret — not sleeping`)
  const activatorIp = await getActivatorPodIp()

  await kubectlApply(buildVclusterSleepEndpointSliceManifest(
    name, vcNs, vclusterLabels(name, worktreeId), activatorIp,
  ))
  await kubectlWithRetry([
    'scale', 'deployment', name, '-n', vcNs, '--replicas=0',
  ])

  // The control-plane pod, matched like the control-plane policy: the
  // chart labels minus the syncer-stamped managed-by no tenant pod can
  // shed (see buildVclusterControlPlaneNpManifest).
  const cpSelector = `app=vcluster,release=${name},!${LABEL_VCLUSTER_MANAGED_BY}`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const list = await kubectlGetJson<{ items?: unknown[] }>([
      'get', 'pods', '-n', vcNs, '-l', cpSelector,
    ])
    if ((list?.items ?? []).length === 0) break
    if (Date.now() > deadline) {
      throw new Error(`vcluster ${name} control plane did not terminate within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }

  await kubectlWithRetry([
    'delete', 'pods', '-n', vcNs,
    '-l', `${LABEL_VCLUSTER_MANAGED_BY}=${name}`,
    '--ignore-not-found', '--wait=false',
  ])
}

/**
 * Tear down one vcluster. With each vcluster in its own host namespace,
 * deleting the namespace removes everything inside it in one shot — the
 * control plane, synced pods, the egress floor and control-plane
 * policies, the inner ingress locks, the RBAC
 * Role/RoleBinding, and the kubeconfig Secret. Things that live outside it
 * are unaffected: the cluster-scoped objects (ClusterRole/Binding, the VAP
 * policy/binding — deleted by our ownership label), the worktree NetworkPolicy
 * in the install namespace (it selects the worktree pod, so it can't move —
 * deleted by label there), and netd's node-level redirect state, which is
 * per-install rather than per-vcluster: it drops the departed pods' rules on
 * its next reconcile once the namespace's pods stop being observed.
 */
export function vclusterCleanupKubectlArgs(name: string): string[][] {
  return [
    [
      'delete', 'namespace', vclusterNamespace(name),
      '--ignore-not-found', '--wait=false',
    ],
    [
      'delete',
      'clusterroles,clusterrolebindings,validatingadmissionpolicies,validatingadmissionpolicybindings',
      '-l', `${LABEL_VCLUSTER}=${name}`,
      '--ignore-not-found', '--wait=false',
    ],
    [
      'delete', 'networkpolicies',
      '-l', `${LABEL_VCLUSTER}=${name}`,
      '-n', k8sNamespace(), '--ignore-not-found', '--wait=false',
    ],
  ]
}

/** The cleanup as host-shell lines for the detached teardown script. */
export function buildVclusterCleanupShellCommand(name: string): string {
  return vclusterCleanupKubectlArgs(name)
    .map((args) => `kubectl ${args.join(' ')} 2>/dev/null || true`)
    .join('; ')
}

/** Best-effort in-process teardown of one vcluster (both cleanup paths). */
export async function removeWorktreeVcluster(name: string): Promise<void> {
  for (const args of vclusterCleanupKubectlArgs(name)) {
    try {
      await kubectlWithRetry(args, { maxAttempts: 2, timeout: 30_000 })
    } catch (err) {
      console.warn(`vcluster cleanup (${name}): ${(err as Error).message}`)
    }
  }
}

/** Derive the status phase from the control-plane Deployment (exported
 *  for unit tests; `getVclusterStatus` reads the live object). */
export function vclusterPhase(
  spec: { replicas?: number } | undefined,
  readyReplicas: number,
): VirtualClusterStatus['phase'] {
  if ((spec?.replicas ?? 0) === 0) return 'asleep'
  return readyReplicas >= 1 ? 'ready' : 'waking'
}

/** Status block for `WorktreeDetail`; null when the worktree has no vcluster. */
export async function getVclusterStatus(
  worktreeId: string,
): Promise<VirtualClusterStatus | null> {
  const name = vclusterName(worktreeId)
  const dep = await kubectlGetJson<{
    spec?: { replicas?: number }
    status?: { readyReplicas?: number }
  }>([
    'get', 'deployment', name, '-n', vclusterNamespace(name),
  ])
  if (!dep) return null
  const readyReplicas = dep.status?.readyReplicas ?? 0
  return {
    name,
    ready: readyReplicas >= 1,
    phase: vclusterPhase(dep.spec, readyReplicas),
  }
}
