import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { buildVclusterFallbackRedirectCnpManifest } from '#features/cluster/bootstrap'
import {
  dataDirHash,
  execFileAsync,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#platform/k8s/kubectl'
import {
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
} from '#platform/k8s/gvisor'
import { LABEL_SESSION_ID, LABEL_VCLUSTER_MANAGED_BY, VCLUSTER_API_PORT } from '#platform/k8s/pods'
import { ensurePinnedBinary } from '#platform/k8s/pinned-binary'
import { pushImageToRegistry, registryHasTag, registryHost } from '#features/cluster/registry'
import { imageExists } from '#platform/container/runtime'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'

export const VCLUSTER_DIR = path.join(PACKAGE_ROOT, 'k8s', 'vcluster')

/**
 * Pinned Helm version yaac shells out to for `helm template`: used from
 * PATH when present, otherwise fetched once and cached under
 * ~/.cache/yaac/bin (ensurePinnedBinary, shared with the cilium CLI).
 */
const HELM_VERSION = 'v3.16.4'

/** Ownership labels stamped on every vendored object (cleanup/GC keys). */
export const LABEL_VCLUSTER = 'yaac.vcluster'
export const LABEL_VCLUSTER_SESSION_ID = 'yaac.vcluster-session-id'
export const LABEL_VCLUSTER_DATA_DIR_HASH = 'yaac.vcluster-data-dir-hash'

/**
 * Name prefix of the per-session ValidatingAdmissionPolicy gating
 * synced pods. Per-session (prefix + vcluster name), not a shared
 * static policy with per-session params: VAP paramRef resolution is
 * broken on current kind/k8s 1.36 ("no params found" even for a
 * minimal textbook policy), and the only parameter was one string —
 * the allowed hostPath prefix — which inlines into the CEL just fine.
 */
export const VCLUSTER_POD_GUARD_POLICY = 'yaac-vcluster-pod-guard'

/** Per-session pod-guard policy/binding name. */
export function vclusterGuardName(name: string): string {
  return `${VCLUSTER_POD_GUARD_POLICY}-${name}`
}

/** Escape a string for embedding in a single-quoted CEL literal. */
function celString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Per-session vcluster name: `yvc-<sid8>`. Eight hex chars of the
 * session UUID — short enough that every chart-derived name
 * (vc-config-<name>, ClusterRole <name>-v-<ns>, …) stays under the
 * 63-char label cap, unique enough across the handful of coexisting
 * vclusters the cap allows.
 */
export function vclusterName(sessionId: string): string {
  const sid8 = sessionId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  return `yvc-${sid8}`
}

/** Secret the syncer writes the exported kubeconfig into. */
export function vclusterKubeconfigSecretName(name: string): string {
  return `vc-${name}`
}

/**
 * Dedicated host namespace for one session's vcluster. vcluster enforces
 * one vcluster per host namespace (it owns the namespace's resource-name
 * space), so each session gets its own `<install-ns>-vc-<sid8>` — this is
 * what lets two virtualCluster sessions run in parallel. Prefixed with
 * the install namespace so coexisting installs don't collide and so e2e
 * per-run namespaces (yaac-test-*) sweep these too.
 */
export function vclusterNamespace(name: string): string {
  return `${k8sNamespace()}-vc-${name.replace(/^yvc-/, '')}`
}

export interface VclusterRenderParams {
  sessionId: string
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
 * shared with the cilium CLI). yaac only needs helm for `helm template`
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
 * Render one session's vcluster manifests by running `helm template`
 * against the vendored chart tarball (offline) with the per-session
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
  const name = vclusterName(p.sessionId)
  // The session pod reaches the API by its in-cluster service-DNS name,
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
    // Per-session overrides. --set-string so an all-digits registry host
    // is never coerced to a number.
    '--set-string', `controlPlane.advanced.defaultImageRegistry=${registryHost()}`,
    '--set-string', `controlPlane.proxy.extraSANs[0]=${apiHost}`,
    '--set-string', `exportKubeConfig.server=https://${apiHost}:${VCLUSTER_API_PORT}`,
  ], { maxBuffer: 16 * 1024 * 1024 })
  return addYaacLabels(stdout, vclusterLabels(name, p.sessionId))
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

function vclusterLabels(name: string, sessionId: string): Record<string, string> {
  return {
    [LABEL_VCLUSTER]: name,
    [LABEL_VCLUSTER_SESSION_ID]: sessionId,
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
  sessionId: string,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: vclusterNamespace(name), labels: vclusterLabels(name, sessionId) },
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
 * The per-session synced-pod guard: a ValidatingAdmissionPolicy whose
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
 *   - hostPath volumes only under the session's nested data dir (param)
 *   - no hostNetwork / hostPID / hostIPC / hostPorts / privileged
 *   - capabilities.add or an explicit allowPrivilegeEscalation: true require
 *     the gvisor runtime tier; seccomp Unconfined is denied outright
 *
 * CEL nil-handling: an absent allowPrivilegeEscalation defaults to TRUE at
 * runtime, but the rule matches only an explicit `true` — nil with no added
 * caps is the stock pod default (file caps cannot exceed the bounding set),
 * and `capabilities.add` is the load-bearing gate.
 *
 * The rule admits the nested-session securityContext (the rootful engine's
 * in-sandbox capability adds under the gvisor tier) that an inner yaac's
 * synced session pods carry.
 */
export function buildVclusterPodGuardPolicyManifest(
  name: string,
  sessionId: string,
  allowedHostPathPrefix: string,
): Record<string, unknown> {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: {
      name: vclusterGuardName(name),
      labels: vclusterLabels(name, sessionId),
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
 * Per-session binding: scopes this vcluster's guard to its synced pods
 * via the syncer's managed-by label, restricted to the vcluster's own
 * host namespace.
 */
export function buildVclusterPodGuardBindingManifest(
  name: string,
  sessionId: string,
): Record<string, unknown> {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicyBinding',
    metadata: {
      name: vclusterGuardName(name),
      labels: vclusterLabels(name, sessionId),
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
 * Per-session NetworkPolicy `yaac-vc-<sid8>` for the SESSION pod. The
 * session pod lives in the install namespace, but its vcluster API and
 * synced pods are in the vcluster's own namespace — so the egress peers
 * are CROSS-NAMESPACE (namespaceSelector + podSelector). It admits the
 * session pod to reach ITS OWN vcluster API on 8443 and its synced pods
 * (managed-by label; the OSS syncer cannot stamp yaac.session-id, see
 * values.yaml). The SOLE egress hole for these flows: Cilium unions allow
 * rules across policies, so this punches a per-session hole through the
 * install-wide session-egress CNP's default-deny (which has no in-cluster
 * 8443 allowance — a blanket rule there would open every session's
 * vcluster API to every other session).
 */
export function buildVclusterSessionNetworkPolicyManifest(
  name: string,
  sessionId: string,
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
      labels: vclusterLabels(name, sessionId),
    },
    spec: {
      podSelector: { matchLabels: { [LABEL_SESSION_ID]: sessionId } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ ...vcNsSelector, podSelector: { matchLabels: { app: 'vcluster', release: name } } }],
          ports: [{ protocol: 'TCP', port: VCLUSTER_API_PORT }],
        },
        {
          to: [{ ...vcNsSelector, podSelector: { matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: name } } }],
        },
      ],
    },
  }
}

/**
 * CiliumNetworkPolicy locking the vcluster control-plane pod down: it
 * holds host-API credentials and could otherwise be an egress escape
 * hatch (e.g. via webhooks). Allowed: the host apiserver + host entity
 * (kubelet proxying for exec/logs), kube-dns, its own synced pods, and
 * itself (the Service hairpin its kubelet port produces).
 *
 * `managed-by DoesNotExist` is load-bearing, not cosmetic: the real
 * control-plane pod is chart-created in the namespace and carries NO
 * managed-by label, whereas EVERY synced pod carries it (syncer-stamped,
 * unforgeable). Without this guard a tenant could create a synced pod
 * labelled `app=vcluster, release=<vc>` — those labels propagate to the
 * host pod — and, since CNP allows union, inherit this policy's
 * kube-apiserver + host egress, reaching the host API server directly.
 * The guard excludes every synced pod by the one label they cannot forge.
 */
export function buildVclusterControlPlaneCnpManifest(
  name: string,
  sessionId: string,
): Record<string, unknown> {
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: `${name}-control-plane`,
      // The control-plane pod lives in the vcluster's own namespace.
      namespace: vclusterNamespace(name),
      labels: vclusterLabels(name, sessionId),
    },
    spec: {
      endpointSelector: {
        matchLabels: { app: 'vcluster', release: name },
        matchExpressions: [{ key: LABEL_VCLUSTER_MANAGED_BY, operator: 'DoesNotExist' }],
      },
      egress: [
        { toEntities: ['kube-apiserver', 'host'] },
        {
          toEndpoints: [{
            matchLabels: {
              'k8s:io.kubernetes.pod.namespace': 'kube-system',
              'k8s-app': 'kube-dns',
            },
          }],
        },
        { toEndpoints: [{ matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: name } }] },
        { toEndpoints: [{ matchLabels: { app: 'vcluster', release: name } }] },
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
 * createSession stands the vcluster up BEFORE the session Job (the Job
 * mounts the vcluster's kubeconfig, so the vcluster must exist first),
 * which leaves a window where the vcluster carries a session-id that no
 * live pod/Job advertises yet. The reconcile tick must not reap it
 * during that window — sized to comfortably cover a cold session create
 * (image pulls + vcluster rollout + worktree).
 */
export const VCLUSTER_ORPHAN_GRACE_MS = 15 * 60 * 1000

export interface VclusterNamespaceInfo {
  /** The vcluster (release) name, `yvc-<sid8>`. */
  name: string
  /** Owning session id. */
  sessionId: string
  /** The dedicated host namespace. */
  namespace: string
  /** Namespace creationTimestamp (ISO) — the orphan-GC grace anchor. */
  creationTimestamp: string
}

interface RawNamespaceList {
  items: Array<{
    metadata: { name: string; labels?: Record<string, string>; creationTimestamp?: string }
  }>
}

/**
 * List this install's vcluster host namespaces (one per live vcluster).
 * The namespace is the top-level object — listing it (rather than the
 * Deployment inside it) means a half-created vcluster whose Deployment
 * never landed is still GC'd.
 */
export async function listVclusterNamespaces(): Promise<VclusterNamespaceInfo[]> {
  const list = await kubectlGetJson<RawNamespaceList>([
    'get', 'namespaces',
    '-l', `${LABEL_VCLUSTER},${LABEL_VCLUSTER_DATA_DIR_HASH}=${dataDirHash()}`,
  ])
  return (list?.items ?? []).flatMap((n) => {
    const name = n.metadata.labels?.[LABEL_VCLUSTER]
    const sessionId = n.metadata.labels?.[LABEL_VCLUSTER_SESSION_ID]
    if (!name || !sessionId) return []
    return [{
      name,
      sessionId,
      namespace: n.metadata.name,
      creationTimestamp: n.metadata.creationTimestamp ?? '',
    }]
  })
}

export interface EnsureVclusterParams {
  sessionId: string
  /** VAP param: the only hostPath prefix synced pods may mount. */
  allowedHostPathPrefix: string
  /** Progress hook (session-create's emit); called for slow waits. */
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
 * re-ensures the SAME name seconds later (session ids are stable across
 * restarts) while termination — pod grace periods, Cilium endpoint
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
 * Stand up one session's vcluster: VAP guard first (no synced pod may
 * ever be admitted unguarded), then the confinement policies, then the
 * chart. Fail-closed on a missing VAP API — synced-pod containment
 * rests on the guard, so there is no opt-out.
 */
export async function ensureSessionVcluster(p: EnsureVclusterParams): Promise<void> {
  const name = vclusterName(p.sessionId)
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

  // The vcluster's own namespace first (vcluster owns one per namespace).
  await kubectlApply(buildVclusterNamespaceManifest(name, p.sessionId))

  await kubectlApply(
    buildVclusterPodGuardPolicyManifest(name, p.sessionId, p.allowedHostPathPrefix),
  )
  await kubectlApply(buildVclusterPodGuardBindingManifest(name, p.sessionId))

  // The API Service's ClusterIP is allocator-assigned (no longer pinned), so
  // there is no immutable-field migration: the chart apply below creates it
  // once and never needs to recreate it.

  // Confinement BEFORE the control plane exists: Cilium fails closed, so the
  // synced-pod egress floor must be in place before the syncer creates its first
  // host pod (CoreDNS appears within seconds) — otherwise a pod with no policy
  // selecting it would get default-ALLOW egress, a cold-start window to raw
  // world. The session policy lives in the install namespace (it selects the
  // session pod); the fallback redirect CNP (the synced-pod floor: default-deny
  // + world→outer proxy + intracluster) and the control-plane CNP live in the
  // vcluster namespace. The fallback CNP is a STATIC per-vcluster policy seeded
  // here and torn down with the namespace — nothing deletes it in between, so
  // the server reconcile does not re-assert it (it only projects the dynamic
  // inner override once an inner yaac's proxy appears). Its redirect listeners
  // live in the SHARED cluster-scoped fallback CCEC (created once at bootstrap,
  // ensureProxyResources), referenced by kind — so creating a vcluster adds NO
  // Envoy listener and never triggers a node-wide endpoint regeneration.
  await kubectlApply(buildVclusterSessionNetworkPolicyManifest(name, p.sessionId))
  await kubectlApply(buildVclusterFallbackRedirectCnpManifest(vcNs, name))
  await kubectlApply(buildVclusterControlPlaneCnpManifest(name, p.sessionId))
  await kubectlWithRetry(['apply', '-f', '-'], {
    input: await renderVclusterManifests({ sessionId: p.sessionId }),
  })
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

/**
 * Tear down one vcluster. With each vcluster in its own host namespace,
 * deleting the namespace removes everything inside it in one shot — the
 * control plane, synced pods, the fallback-redirect CNP and control-plane
 * policies, any server-projected inner-redirect objects, the RBAC
 * Role/RoleBinding, and the kubeconfig Secret. Things that live outside it
 * are unaffected: the cluster-scoped objects (ClusterRole/Binding, the VAP
 * policy/binding — deleted by our ownership label), the session NetworkPolicy
 * in the install namespace (it selects the session pod, so it can't move —
 * deleted by label there), and the SHARED fallback-redirect CCEC (a per-install
 * singleton the CNP references by kind; it serves every vcluster, so it is
 * intentionally NOT torn down here — it goes with the install).
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
export async function removeSessionVcluster(name: string): Promise<void> {
  for (const args of vclusterCleanupKubectlArgs(name)) {
    try {
      await kubectlWithRetry(args, { maxAttempts: 2, timeout: 30_000 })
    } catch (err) {
      console.warn(`vcluster cleanup (${name}): ${(err as Error).message}`)
    }
  }
}

export interface VclusterStatus {
  name: string
  ready: boolean
}

/** Status block for `SessionDetail`; null when the session has no vcluster. */
export async function getVclusterStatus(sessionId: string): Promise<VclusterStatus | null> {
  const name = vclusterName(sessionId)
  const dep = await kubectlGetJson<{ status?: { readyReplicas?: number } }>([
    'get', 'deployment', name, '-n', vclusterNamespace(name),
  ])
  if (!dep) return null
  return {
    name,
    ready: (dep.status?.readyReplicas ?? 0) >= 1,
  }
}
