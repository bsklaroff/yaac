import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import {
  LABEL_PROJECT,
  LABEL_ROLE,
  LABEL_SESSION_ID,
  PRIORITY_CLASS_INFRA,
  dataDirHash,
  execFileAsync,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  runPodToCompletion,
  untoleratedTaints,
} from '#platform/k8s'
import type { NodeTaint } from '#platform/k8s'
import { createKeyedMutex } from '#platform/keyed-mutex'
import { pushImageToRegistry, registryHasTag, registryRef } from '#platform/container'
import { nodeIpBlocks } from './cluster-cidrs'
import { imageExists } from '#platform/container'
import { projectDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#log'

/** `app` label value shared by every per-project registry pod. */
export const REGISTRY_APP_LABEL = 'yaac-registry'
/**
 * GC scope label: ties registry objects to this yaac install without
 * making them visible to the session reaper/list paths (which filter on
 * `yaac.data-dir-hash` + `yaac.session-id`).
 */
export const LABEL_REGISTRY_DATA_DIR_HASH = 'yaac.registry-data-dir-hash'
/**
 * Marker label on the one-shot node-write pods (hosts writer / cleanup),
 * value = the pod's kind. Distinguishes them from the registry
 * Deployment's pod, which carries the same registry labels — the stray
 * sweep in `writeNodeRegistryHostsToml` selects on this label's existence
 * so it can never delete the registry itself.
 */
export const LABEL_NODE_WRITE = 'yaac.node-write'
/**
 * In-cluster port of the per-project registry. Deliberately not 443/80:
 * netd redirects those to the proxy, whereas 5000 rides the per-project
 * sessions NetworkPolicy straight to the registry, un-MITM'd.
 */
export const PROJECT_REGISTRY_PORT = 5000

/**
 * Upstream registry:2 pinned by its multi-arch index digest — the same
 * image the main local registry runs. Push-and-serve only: no
 * pull-through, no sync, no config beyond storage (nested image pulls go
 * through the MITM proxy instead).
 */
export const REGISTRY_IMAGE_DIGEST =
  'sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373'
export const REGISTRY_UPSTREAM_IMAGE = `docker.io/library/registry@${REGISTRY_IMAGE_DIGEST}`
/** Local mirror tag; the digest slice keeps it stable and content-keyed. */
export const REGISTRY_MIRROR_TAG = `yaac-registry2:${REGISTRY_IMAGE_DIGEST.slice(7, 19)}`

/**
 * Deployment/Service name for a project's registry:
 * `yaac-reg-<safeSlug≤21>-<hash8>`. The hash spans the data dir + the
 * full slug, so truncated slugs stay unique and coexisting installs
 * sharing a namespace cannot collide. Total length stays well under the
 * 63-char DNS-label cap.
 */
export function projectRegistryName(projectSlug: string): string {
  const safeSlug = projectSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 21)
  const hash8 = crypto.createHash('sha256')
    .update(`${dataDirHash()}/${projectSlug}`)
    .digest('hex')
    .slice(0, 8)
  return `yaac-reg-${safeSlug}-${hash8}`.replace(/--+/g, '-')
}

/**
 * The in-cluster service-DNS name of the registry. A FULL `.svc.cluster.local`
 * FQDN, not the `.svc` shorthand: sessions resolve it through the proxy's
 * split-horizon DNS, which forwards ONLY `.cluster.local` to CoreDNS (a bare
 * `.svc` would be sinkholed, since CoreDNS forwards anything outside its zone
 * to the remote resolver — a DNS-exfil channel). The node's containerd matches
 * it via the hosts.toml this module writes (it never DNS-resolves it).
 */
export function projectRegistryHostname(projectSlug: string): string {
  return `${projectRegistryName(projectSlug)}.${k8sNamespace()}.svc.cluster.local`
}

/** `projectRegistryHostname` with the registry port (the image-ref host). */
export function projectRegistryHost(projectSlug: string): string {
  return `${projectRegistryHostname(projectSlug)}:${PROJECT_REGISTRY_PORT}`
}

/**
 * Node-local hostPath backing the registry's storage. Node-local (not
 * under the data dir) on purpose: registry blob layouts are hostile to
 * virtiofs, and loss on cluster recreate only costs re-pushes. Growth is
 * bounded by reconcileProjectRegistryGc, which reclaims the blobs behind
 * manifests no tag points at; live tags are never collected, so
 * a project that keeps minting NEW tags (content-hash image chains) still
 * grows until it is removed.
 */
export function projectRegistryStorageHostPath(projectSlug: string): string {
  return `/var/lib/yaac/registry/${dataDirHash()}/${projectSlug}`
}

/**
 * registries.conf.d drop-in making user-driven `docker push` from a
 * session accept the registry's plain HTTP. Written into the session at
 * setup time (the host is per-project, so it cannot be baked into the
 * shared nestable layer). Scoped to the exact registry host — every
 * other registry keeps full TLS verification.
 */
export function projectRegistryConfDropIn(projectSlug: string): string {
  return [
    '[[registry]]',
    `location = "${projectRegistryHost(projectSlug)}"`,
    'insecure = true',
    '',
  ].join('\n')
}

function registryLabels(projectSlug: string): Record<string, string> {
  return {
    app: REGISTRY_APP_LABEL,
    [LABEL_PROJECT]: projectSlug,
    [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
  }
}

/**
 * kubectl label selector matching every registry object of this project
 * scoped to this install (coexisting installs sharing a namespace never
 * touch each other's registries).
 */
function registrySelector(projectSlug: string): string {
  return [
    `app=${REGISTRY_APP_LABEL}`,
    `${LABEL_PROJECT}=${projectSlug}`,
    `${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()}`,
  ].join(',')
}

/** Records which node a project registry's blob store lives on. */
const REGISTRY_NODE_ANNOTATION = 'yaac.dev/registry-node'

/**
 * The node a project's registry must run on: wherever its blobs already
 * are, since the store is a node-local hostPath.
 *
 * Answered in order of how much the answer is worth: an existing pin is
 * authoritative; a running pod's node is what the pin would have said had
 * one been recorded (this is the migration path for registries created
 * before pinning, and it keeps their blobs); otherwise this is a first
 * placement and any node that can take work will do, chosen by name so
 * repeated calls agree.
 *
 * Returns null when no node can be resolved at all, which leaves the
 * Deployment unpinned rather than pinning it to a guess — an unpinned
 * registry still works, it just has the old rescheduling exposure.
 */
async function resolveRegistryNode(projectSlug: string): Promise<string | null> {
  const ns = k8sNamespace()
  interface RawDeploy { metadata?: { annotations?: Record<string, string> } }
  const existing = await kubectlGetJson<RawDeploy>([
    'get', 'deployment', projectRegistryName(projectSlug), '-n', ns,
  ]).catch(() => null)
  const pinned = existing?.metadata?.annotations?.[REGISTRY_NODE_ANNOTATION]
  if (pinned) return pinned

  interface RawPodList { items?: Array<{ spec?: { nodeName?: string } }> }
  const pods = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', ns, '-l', registrySelector(projectSlug),
  ]).catch(() => null)
  const onNode = (pods?.items ?? []).map((p) => p.spec?.nodeName).find(Boolean)
  if (onNode) return onNode

  interface RawNodeList {
    items?: Array<{
      metadata?: { name?: string }
      spec?: { unschedulable?: boolean; taints?: NodeTaint[] }
      status?: { conditions?: Array<{ type?: string; status?: string }> }
    }>
  }
  const nodes = await kubectlGetJson<RawNodeList>(['get', 'nodes']).catch(() => null)
  // Matched against an EMPTY toleration set on purpose, and that is the
  // whole statement: this Deployment is trusted infra, stamps no
  // RuntimeClass, and so declares no tolerations — every blocking taint
  // really does rule its node out. Written as matching rather than as "has
  // no taint" so a tainted sessions pool is excluded for the right reason:
  // the pool's toleration lives on the gvisor RuntimeClass, which this pod
  // deliberately does not name, so a project registry must never land there.
  const candidates = (nodes?.items ?? [])
    .filter((n) =>
      (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')
      && n.spec?.unschedulable !== true
      && untoleratedTaints(n.spec?.taints, []).length === 0)
    .map((n) => n.metadata?.name)
    .filter((n): n is string => !!n)
    .sort()
  return candidates[0] ?? null
}

/**
 * Build the registry:2 Deployment. Trusted infra like the proxy, so no
 * runtimeClassName — it runs on runc; the sentry buys no containment for
 * yaac-shipped code and its CPU cost starves the node (see the gvisor.ts
 * module doc). Recreate strategy: two pods would race over the node-local
 * storage hostPath during a rolling overlap.
 *
 * `node` pins it to where its blobs are — see resolveRegistryNode.
 */
export function buildProjectRegistryDeploymentManifest(
  projectSlug: string,
  imageRef: string,
  opts: { readOnly?: boolean; node?: string | null } = {},
): Record<string, unknown> {
  const name = projectRegistryName(projectSlug)
  const selector = { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug }
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
      // The pin is recorded here, not merely expressed in the affinity
      // below, so the next ensure can read back which node this
      // registry's blobs are on without having to find a live pod.
      ...(opts.node ? { annotations: { [REGISTRY_NODE_ANNOTATION]: opts.node } } : {}),
    },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: registryLabels(projectSlug) },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // Pinned to the node holding its storage. The blob store is a
          // node-local hostPath, so the pod and its data are one unit: a
          // rollout that lands elsewhere comes up serving an EMPTY
          // catalog, silently turning every cross-session layer hit into
          // a rebuild. Single-node clusters never showed this because
          // there was nowhere else for a Recreate to land.
          //
          // Affinity rather than nodeName: this still goes through the
          // scheduler, so a cordoned or pressured node leaves the pod
          // Pending (visible, recoverable) instead of being force-bound
          // to a node that cannot take it.
          ...(opts.node
            ? {
              affinity: {
                nodeAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: {
                    nodeSelectorTerms: [{
                      matchExpressions: [{
                        key: 'kubernetes.io/hostname',
                        operator: 'In',
                        values: [opts.node],
                      }],
                    }],
                  },
                },
              },
            }
            : {}),
          // Infra tier: the project's sessions pull their images from here,
          // so evicting it to make room for a session is backwards.
          priorityClassName: PRIORITY_CLASS_INFRA,
          containers: [
            {
              name: 'registry',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              // Manifest DELETE, which the image cache's retire leg uses to
              // drop chain slots a shorter rebuild no longer fills, and
              // which is what leaves their blobs collectable. Scoped by the
              // same policies as every other write to this registry: only
              // this project's own sessions can reach it.
              //
              // `readOnly` is the maintenance window a blob collect runs in
              // (reconcileProjectRegistryGc): pulls and the catalog keep
              // serving, pushes and deletes answer 405. Spelled as an
              // inline YAML MAP — the `…_READONLY_ENABLED=true` spelling
              // collapses the key to a scalar and registry 2.8 panics at
              // boot with "readonly config key must contain additional
              // keys".
              env: [
                { name: 'REGISTRY_STORAGE_DELETE_ENABLED', value: 'true' },
                ...(opts.readOnly
                  ? [{ name: 'REGISTRY_STORAGE_MAINTENANCE_READONLY', value: '{enabled: true}' }]
                  : []),
              ],
              ports: [{ containerPort: PROJECT_REGISTRY_PORT }],
              readinessProbe: {
                httpGet: { path: '/v2/', port: PROJECT_REGISTRY_PORT },
                periodSeconds: 2,
                failureThreshold: 30,
              },
              volumeMounts: [
                { name: 'storage', mountPath: '/var/lib/registry' },
              ],
            },
          ],
          volumes: [
            {
              name: 'storage',
              hostPath: {
                path: projectRegistryStorageHostPath(projectSlug),
                type: 'DirectoryOrCreate',
              },
            },
          ],
        },
      },
    },
  }
}

export function buildProjectRegistryServiceManifest(projectSlug: string): Record<string, unknown> {
  const name = projectRegistryName(projectSlug)
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      type: 'ClusterIP',
      // Allocator-assigned (no longer pinned): sessions resolve the live
      // ClusterIP through the proxy's split-horizon DNS, and the node's
      // hosts.toml is rewritten with the live IP on every ensure.
      selector: { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug },
      // port == targetPort: the network policies list the post-translation
      // port; a remap would diverge.
      ports: [{
        name: 'registry',
        port: PROJECT_REGISTRY_PORT,
        targetPort: PROJECT_REGISTRY_PORT,
      }],
    },
  }
}

/**
 * NetworkPolicy admitting this project's sessions to this project's
 * registry — the SOLE egress hole for session→registry traffic:
 * NetworkPolicy unions allow rules, so this punches an exactly-scoped
 * hole through the session-egress policy's default-deny (which itself has
 * no in-cluster registry allowance — an install-wide rule there could
 * not express "same project only"; see that builder's comment).
 * Per-project rather than shared because registry:2 has no path ACLs: a
 * shared writable registry
 * would let any session overwrite another project's (or the infra) tags.
 * The session-id Exists term keeps the policy off the registry pod
 * itself (it carries the project label too).
 */
export function buildRegistrySessionsNetworkPolicyManifest(
  projectSlug: string,
): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${projectRegistryName(projectSlug)}-sessions`,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      podSelector: {
        matchLabels: { [LABEL_PROJECT]: projectSlug },
        matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }],
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{
            podSelector: {
              matchLabels: { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug },
            },
          }],
          ports: [{ protocol: 'TCP', port: PROJECT_REGISTRY_PORT }],
        },
      ],
    },
  }
}

/**
 * NetworkPolicy locking the registry pod's INGRESS to exactly its two
 * legitimate clients: same-project session pods pushing on 5000, and the
 * NODE — the kubelet readiness probe plus containerd pulling pushed refs
 * from the host netns via hosts.toml. The sessions policy above already
 * stops other projects' sessions at their source; this is the
 * receiving-side lock, so no future egress loosening can silently reopen
 * cross-project tag reads or overwrites (registry:2 has no path ACLs).
 *
 * The node half is an `ipBlock` because the pulls originate in the host
 * network namespace, which plain NetworkPolicy can only name by address
 * (NetworkPolicy has no selector for the host network namespace).
 */
export function buildRegistryIngressNetworkPolicyManifest(
  projectSlug: string,
  nodeCidrs: string[],
): Record<string, unknown> {
  const registryPort = { protocol: 'TCP', port: PROJECT_REGISTRY_PORT }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${projectRegistryName(projectSlug)}-ingress`,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      podSelector: {
        matchLabels: { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug },
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{
            podSelector: {
              matchLabels: { [LABEL_PROJECT]: projectSlug },
              matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }],
            },
          }],
          ports: [registryPort],
        },
        {
          from: nodeCidrs.map((cidr) => ({ ipBlock: { cidr } })),
          ports: [registryPort],
        },
      ],
    },
  }
}

/**
 * Deny-all egress on the registry pod: it only ever serves pushes and
 * pulls — there is nothing for it to fetch (no pull-through, no proxy
 * pseudo-session). Ingress is locked separately by
 * buildRegistryIngressNetworkPolicyManifest.
 */
export function buildRegistryEgressNetworkPolicyManifest(
  projectSlug: string,
): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${projectRegistryName(projectSlug)}-egress`,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      podSelector: {
        matchLabels: { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug },
      },
      policyTypes: ['Egress'],
      egress: [],
    },
  }
}

/**
 * Scaffolding shared by the one-shot node-write pods that replaced the
 * old `podman exec <node>` writes: node files are written by a pod that
 * hostPath-mounts the target directory, so the server never assumes the
 * node is a container on its own podman engine. Pinned by `nodeName`, plain
 * root like the registry itself, `restartPolicy: Never` — the caller polls
 * it to a terminal phase and deletes it. Names carry a per-run random suffix so
 * two runs can never fight over one pod name (delete each other's pod
 * mid-poll); strays from crashed runs are reaped by label — the
 * `LABEL_NODE_WRITE` sweep before each hosts write, and
 * `removeProjectRegistry`'s by-selector delete. It reuses the registry:2
 * mirror image (already in the local registry, and on the node once the
 * registry Deployment has rolled out), and its registry labels both put
 * it under the deny-all egress NetworkPolicy (it needs no network) and
 * inside the removal selector's scope.
 */
function buildNodeWritePodManifest(
  projectSlug: string,
  kind: 'hosts' | 'cleanup' | 'gc',
  name: string,
  nodeName: string,
  imageRef: string,
  script: string,
  volumes: Array<{ name: string; hostPath: { path: string; type: string } }>,
  volumeMounts: Array<{ name: string; mountPath: string }>,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: { ...registryLabels(projectSlug), [LABEL_NODE_WRITE]: kind },
    },
    spec: {
      nodeName,
      // Trusted infra (runs a fixed yaac-authored script) — no
      // runtimeClassName, so it runs on runc like the proxy and registry.
      restartPolicy: 'Never',
      // Tolerates everything, like netd and the gVisor installer. `nodeName`
      // bypasses the SCHEDULER, so NoSchedule never mattered — but kubelet
      // admits and the taint manager evicts, so a NoExecute taint would
      // refuse this pod on the very nodes it exists to write to: a tainted
      // sessions pool would get no hosts.toml, and its sessions could not
      // pull. Free in scheduling terms — the pod is pinned to one named node
      // and lives for seconds.
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // Infra tier: it is pinned to one node (nodeName) and a session pod
      // filling that node must not keep the registry wiring from landing.
      priorityClassName: PRIORITY_CLASS_INFRA,
      containers: [{
        name: 'write',
        image: imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', script],
        volumeMounts,
      }],
      volumes,
    },
  }
}

/**
 * One-shot pod writing the node containerd hosts.toml for this project's
 * registry. The hostPath is scoped to exactly the one
 * `certs.d/<registry-host>` directory (`DirectoryOrCreate` replaces the
 * old `mkdir -p`), so the pod can affect no other registry's mapping.
 */
export function buildRegistryHostsWriterPodManifest(
  projectSlug: string,
  imageRef: string,
  nodeName: string,
  vip: string,
  nodeIndex: number,
  runId: string,
): Record<string, unknown> {
  const content = `[host."http://${vip}:${PROJECT_REGISTRY_PORT}"]`
  return buildNodeWritePodManifest(
    projectSlug,
    'hosts',
    `${projectRegistryName(projectSlug)}-hosts-${nodeIndex}-${runId}`,
    nodeName,
    imageRef,
    `printf '%s\\n' '${content}' > /host-certs/hosts.toml`,
    [{
      name: 'certs',
      hostPath: {
        path: `/etc/containerd/certs.d/${projectRegistryHost(projectSlug)}`,
        type: 'DirectoryOrCreate',
      },
    }],
    [{ name: 'certs', mountPath: '/host-certs' }],
  )
}

/**
 * One-shot pod removing this project's node-side residue: the certs.d
 * directory and the registry storage. Unlike the writer it mounts the
 * PARENT directories — removing the child dirs themselves (not just
 * their contents) requires it, matching what `podman exec rm -rf` did.
 * Wider mounts than the writer's, but the pod lives for seconds and runs
 * only at project removal.
 */
export function buildRegistryCleanupPodManifest(
  projectSlug: string,
  imageRef: string,
  nodeName: string,
  nodeIndex: number,
  runId: string,
): Record<string, unknown> {
  return buildNodeWritePodManifest(
    projectSlug,
    'cleanup',
    `${projectRegistryName(projectSlug)}-cleanup-${nodeIndex}-${runId}`,
    nodeName,
    imageRef,
    `rm -rf '/host-certs/${projectRegistryHost(projectSlug)}' '/host-storage/${projectSlug}'`,
    [
      {
        name: 'certs',
        hostPath: { path: '/etc/containerd/certs.d', type: 'DirectoryOrCreate' },
      },
      {
        name: 'storage',
        hostPath: { path: `/var/lib/yaac/registry/${dataDirHash()}`, type: 'DirectoryOrCreate' },
      },
    ],
    [
      { name: 'certs', mountPath: '/host-certs' },
      { name: 'storage', mountPath: '/host-storage' },
    ],
  )
}

/** In-GC-pod mount point of the registry storage — the `rootdirectory`
 *  the image's stock config.yml already points `registry` at. */
const GC_STORAGE_PATH = '/var/lib/registry'
/** The stock config the mirrored image ships, which the GC run re-reads. */
const GC_CONFIG_PATH = '/etc/docker/registry/config.yml'
/** v2 layout root holding one directory per repository. */
const GC_REPOS_PATH = `${GC_STORAGE_PATH}/docker/registry/v2/repositories`

/**
 * Content-hash generations kept per yaac-built repo. Deliberately far
 * above the host engine's HOST_GENERATIONS_KEPT of 2: the host's
 * generations are sequential rebuilds of ONE chain, so "current + one
 * rollback" covers it, whereas a project registry serves every session at
 * once and each session on its own branch mints its own hash. The live set
 * is therefore as wide as the fleet, not one deep — keep enough that a
 * parallel session's image is never the thing retention evicts.
 */
export const REGISTRY_GENERATIONS_KEPT = 8

/**
 * The retention pass the collect runs first, and the ONLY thing in this
 * subsystem that drops a tag someone could still name.
 *
 * `--delete-untagged` alone cannot bound a repo whose every build mints a
 * NEW tag: yaac's own chain is content-hash tagged (`yaac-tools:<hash>`),
 * so each source change adds a generation that stays tagged, and therefore
 * stays collectable-by-nothing, forever. This retires all but the newest
 * REGISTRY_GENERATIONS_KEPT of them, which is exactly the policy
 * image-gc.ts already applies to the host engine.
 *
 * Two guards keep it off anything else, because a tag here is otherwise a
 * promise to whoever pulls it:
 *  - the repo must be yaac-built (`yaac-…`) — every push into this
 *    registry names one, and the alias cleanup above has already dropped
 *    the `localhost/`-prefixed spellings by the time this runs — so a
 *    session's own `myapp` repo is never touched;
 *  - the tag must have the 16-hex content-hash shape — so `v1`, `latest`
 *    and the cache's `yaac-cache-…` slots can never match.
 * Retiring a tag only unlinks the name; the manifest it pointed at and its
 * blobs are what the `--delete-untagged` collect then reclaims.
 *
 * Done on the storage layout rather than the delete API because the
 * collect runs inside the read-only window, where DELETE answers 405 —
 * and that window is also what guarantees no client is mid-push while the
 * names move.
 */
export function buildRegistryRetentionScript(keep = REGISTRY_GENERATIONS_KEPT): string {
  return [
    `[ -d ${GC_REPOS_PATH} ] || exit 0`,
    'retired=0',
    `for tagdir in $(find ${GC_REPOS_PATH} -type d -path '*/_manifests/tags' 2>/dev/null); do`,
    `  repo=\${tagdir#${GC_REPOS_PATH}/}; repo=\${repo%/_manifests/tags}`,
    '  case "$repo" in',
    '    yaac-*) ;;',
    '    *) continue;;',
    '  esac',
    // Newest first by tag-dir mtime, which for these tags is their
    // CREATION time: a re-push writes `current/link` and an `index/…`
    // entry INSIDE the tag directory, which does not bump the directory's
    // own mtime. Content-hash tags are write-once, so creation order is
    // exactly the generation order wanted here — but that makes this
    // ordering unsafe to reuse for a mutable tag, which would sort by when
    // it first appeared rather than when it last moved.
    `  for stale in $(ls -1t "$tagdir" 2>/dev/null | grep -Ex '[0-9a-f]{16}' | tail -n +${keep + 1}); do`,
    '    rm -rf "$tagdir/$stale" && retired=$((retired+1))',
    '  done',
    'done',
    'echo "retired-generations $retired"',
  ].join('\n')
}

/**
 * Drop the `localhost/…` alias repos an older salvage left in the store.
 *
 * The image cache pushed podman's ref for a local name verbatim, and
 * podman stores every non-registry-qualified name under its `localhost/`
 * local-registry prefix — so an image the server had already pushed under
 * its bare tag gained a second repo holding a second, independently
 * compressed copy of every layer. The salvage now canonicalizes the name
 * away
 * (LOCAL_REGISTRY_PREFIX in image-promoter), which stops new ones but
 * leaves the existing subtree tagged, and therefore uncollectable, in
 * every registry an older server wrote.
 *
 * Removing the repo directories un-references their manifests, so the
 * `--delete-untagged` collect that follows reclaims the blobs in the same
 * pass. Blobs a surviving repo still names are marked by the collect's own
 * walk, so sharing between an alias and its canonical twin changes how
 * much is reclaimed, never whether a live blob is. What is lost is at most
 * a cache entry the canonical name does not cover: a rebuild, and the next
 * salvage repushes it under the canonical repo.
 *
 * Scoped to exactly this prefix, and a no-op once the subtree is gone: no
 * producer writes `localhost/…` any more — the salvage canonicalizes,
 * host-side pushes use bare mirror tags, prime reads and retire only
 * DELETEs. A session can still `docker push <registry>/localhost/…` by
 * hand (the registry has no path ACLs), which this drops again on the next
 * pass, costing that session the cache entry it minted.
 */
function buildAliasRepoCleanupScript(): string {
  return [
    `if [ -d ${GC_REPOS_PATH}/localhost ]; then`,
    `  rm -rf ${GC_REPOS_PATH}/localhost && echo "dropped-alias-repos"`,
    'fi',
  ].join('\n')
}

/**
 * One-shot pod reclaiming a project's registry blobs: drop the legacy
 * alias repos, retire stale content-hash generations, then `registry
 * garbage-collect --delete-untagged` against the storage hostPath with
 * the registry's own binary and stock config.
 *
 * `--delete-untagged` is what makes this worth running at all. Both image
 * flows into this registry REUSE tags — the image cache pushes
 * `<repo>:<tag>` and `<repo>:yaac-cache-<tag>-<n>` under the names the
 * session already had, and a rebuilt tag re-points at fresh bytes — so
 * every rebuild leaves the previous manifest referenced by no tag at all.
 * Those are exactly the manifests this deletes, and their blobs go with
 * them. The retention pass above is what feeds it the one class of
 * garbage it could not otherwise see.
 */
export function buildRegistryGcPodManifest(
  projectSlug: string,
  imageRef: string,
  nodeName: string,
  runId: string,
): Record<string, unknown> {
  return buildNodeWritePodManifest(
    projectSlug,
    'gc',
    `${projectRegistryName(projectSlug)}-gc-${runId}`,
    nodeName,
    imageRef,
    // Alias cleanup first: the retention pass exits early on a store with
    // no repositories dir at all, and neither must run after the collect
    // that reclaims what they untag.
    `${buildAliasRepoCleanupScript()}\n`
    + `${buildRegistryRetentionScript()}\n`
    + `/bin/registry garbage-collect --delete-untagged=true ${GC_CONFIG_PATH}`,
    [{
      name: 'storage',
      hostPath: { path: projectRegistryStorageHostPath(projectSlug), type: 'DirectoryOrCreate' },
    }],
    [{ name: 'storage', mountPath: GC_STORAGE_PATH }],
  )
}

/**
 * Ensure the registry:2 mirror (digest-pinned) exists in the local
 * registry and return its in-cluster ref — same build-or-skip shape as
 * `ensureRedirectInitImage`. The mirror is what lets the node pull the
 * image with zero upstream egress at pod-create time.
 */
export async function ensureRegistryImage(
  requirePrebuilt = testEnv.requirePrebuiltImages,
): Promise<string> {
  if (await registryHasTag(REGISTRY_MIRROR_TAG)) return registryRef(REGISTRY_MIRROR_TAG)

  if (!await imageExists(REGISTRY_MIRROR_TAG)) {
    if (requirePrebuilt) {
      throw new Error(
        `Registry image ${REGISTRY_MIRROR_TAG} is missing. ` +
        'Restart the test run so the global setup can mirror it.',
      )
    }
    await execFileAsync('podman', ['pull', REGISTRY_UPSTREAM_IMAGE], { timeout: 300_000 })
    await execFileAsync('podman', ['tag', REGISTRY_UPSTREAM_IMAGE, REGISTRY_MIRROR_TAG])
  }
  return pushImageToRegistry(REGISTRY_MIRROR_TAG)
}

interface RawNodeList {
  items: Array<{ metadata: { name: string } }>
}

/** Node names, for pinning the one-shot node-write pods via `nodeName`. */
async function listNodeNames(): Promise<string[]> {
  const list = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  return (list?.items ?? []).map((n) => n.metadata.name)
}

/**
 * Run a node-write pod to a terminal phase (`runPodToCompletion` owns the
 * delete-stray/apply/poll/cleanup shape) and require Succeeded; failures
 * carry the pod logs.
 */
async function runNodeWritePod(manifest: Record<string, unknown>): Promise<void> {
  const name = (manifest as { metadata: { name: string } }).metadata.name
  const { phase, logs } = await runPodToCompletion(manifest, { timeoutMs: 60_000, pollMs: 500 })
  if (phase !== 'Succeeded') {
    throw new Error(
      `node-write pod ${name} did not complete (phase ${phase})`
      + (logs.trim() ? `; logs: ${logs.trim()}` : ''),
    )
  }
}

/**
 * Write the node containerd hosts.toml mapping the registry's svc-DNS host to
 * its live ClusterIP URL, so `kubectl run` of a pushed ref pulls straight from
 * the in-cluster registry. Written by a one-shot in-cluster pod, NOT
 * `podman exec <node>`: the server host's engine need not be the one hosting
 * the node, and node names need not be container names. The node is not a
 * cluster-DNS client, so it needs the IP here; hosts.toml is read per-pull
 * (no containerd restart) and is rewritten on every ensure, so the
 * allocator-assigned IP is always current. Must run after the Service is
 * applied and the Deployment rolled out (the rollout also guarantees the
 * writer pod's own image is already on the node).
 */
export async function writeNodeRegistryHostsToml(projectSlug: string): Promise<void> {
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', projectRegistryName(projectSlug), '-n', k8sNamespace(),
  ])
  const vip = svc?.spec?.clusterIP
  if (!vip) throw new Error(`project registry Service ${projectRegistryName(projectSlug)} has no ClusterIP yet`)
  // Reap stray writer/cleanup pods left by crashed runs (a daemon killed
  // mid-poll never reaches runPodToCompletion's cleanup delete, and the
  // per-run name suffix means no later namesake delete collects them).
  // The node-write marker keeps the registry Deployment's pod out of the
  // selector's reach.
  await kubectlWithRetry([
    'delete', 'pod', '-l', `${registrySelector(projectSlug)},${LABEL_NODE_WRITE}`,
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
  const imageRef = registryRef(REGISTRY_MIRROR_TAG)
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    await runNodeWritePod(buildRegistryHostsWriterPodManifest(projectSlug, imageRef, node, vip, i, runId))
  }
}

/** Per-project queue behind `ensureProjectRegistry` (see its doc). */
const registryEnsureMutex = createKeyedMutex()

/**
 * Idempotently stand up the project's registry (Deployment + Service + the
 * network policies + node hosts.toml) and wait for it to serve. Called from
 * session-create only for `virtualCluster` sessions — nested-only sessions
 * need no registry. The Service's ClusterIP is allocator-assigned and never
 * deleted, so `apply` is a no-op on it after first creation (the pin and its
 * immutable-field migration are gone).
 *
 * Serialized per project: concurrent creates on one project are routine
 * (a user create racing a prewarm spare spawn and queued yaac-spawn
 * requests — all bursting on the first background tick after a daemon
 * start), and unserialized ensures would interleave the applies,
 * rollout waits, and node-write pod runs. The ensure is idempotent, so
 * the queued caller's turn is quick; different projects still ensure in
 * parallel.
 */
export async function ensureProjectRegistry(projectSlug: string): Promise<void> {
  await registryEnsureMutex(projectSlug, async () => {
    const name = projectRegistryName(projectSlug)
    const ns = k8sNamespace()
    const imageRef = await ensureRegistryImage()

    const node = await resolveRegistryNode(projectSlug)
    await kubectlApply(buildProjectRegistryDeploymentManifest(projectSlug, imageRef, { node }))
    await kubectlApply(buildProjectRegistryServiceManifest(projectSlug))
    await kubectlApply(buildRegistrySessionsNetworkPolicyManifest(projectSlug))
    await kubectlApply(buildRegistryIngressNetworkPolicyManifest(projectSlug, await nodeIpBlocks()))
    await kubectlApply(buildRegistryEgressNetworkPolicyManifest(projectSlug))
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${name}`, '-n', ns, '--timeout=120s',
    ], { timeout: 130_000, maxAttempts: 2 })
    await writeNodeRegistryHostsToml(projectSlug)
  })
}

/**
 * Tear down a project's registry objects plus its node-side residue
 * (hosts.toml dir, storage), the latter via one-shot cleanup pods. The
 * delete selector includes the install scope label so coexisting installs
 * sharing a namespace never delete each other's registries; `pod` is in
 * the kinds so stray writer/cleanup pods from crashed runs are reaped.
 */
export async function removeProjectRegistry(projectSlug: string): Promise<void> {
  const selector = registrySelector(projectSlug)

  // Node-side residue exists only if the registry itself ever did (both
  // dirs are written by the Deployment's pod and the hosts writer). Probe
  // before deleting and skip the cleanup pods for registry-less projects:
  // their cleanup pod can't even start — the mirror image was never pushed,
  // and a nested session's vcluster pod guard denies the node hostPath
  // mounts — so each one would sit Pending for runNodeWritePod's full 60s
  // deadline, stalling every project remove.
  const existing = await kubectlGetJson<{ items?: unknown[] }>([
    'get', 'deployment,service', '-l', selector, '-n', k8sNamespace(),
  ])
  const hadRegistry = (existing?.items?.length ?? 0) > 0

  await kubectlWithRetry([
    'delete', 'deployment,service,networkpolicy,pod', '-l', selector,
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
  if (!hadRegistry) return

  const imageRef = registryRef(REGISTRY_MIRROR_TAG)
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    // Best-effort: the cluster may be recreated or unreachable — and the
    // storage was node-local, so it is already gone with the old node.
    await runNodeWritePod(buildRegistryCleanupPodManifest(projectSlug, imageRef, node, i, runId))
      .catch(() => { /* node-side residue is harmless */ })
  }
}

/**
 * Node-local root the retired image store used to occupy, keyed by
 * install. Nothing mounts it any more — the cross-session image cache is
 * the project registry — so on a machine that ran an older yaac it is
 * multi-GB of dead weight (the store measured 25GB after a day of e2e
 * churn). Swept once per server start.
 */
const LEGACY_IMAGE_STORE_ROOT = '/var/lib/yaac/imagecache'

/** Marker for the one-shot legacy-store sweep pods. */
export const ROLE_LEGACY_STORE_SWEEP = 'legacy-image-store-sweep'

/**
 * One-shot pod deleting this install's retired image-store root on one
 * node. Mounts the PARENT so the install's own directory goes with its
 * contents, exactly like the registry cleanup pod. Pinned by `nodeName`;
 * a node that never ran the old store just sees nothing to delete.
 */
export function buildLegacyStoreSweepPodManifest(
  imageRef: string,
  nodeName: string,
  nodeIndex: number,
  runId: string,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `yaac-imagecache-sweep-${nodeIndex}-${runId}`,
      namespace: k8sNamespace(),
      labels: {
        [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
        [LABEL_ROLE]: ROLE_LEGACY_STORE_SWEEP,
      },
    },
    spec: {
      nodeName,
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      containers: [{
        name: 'sweep',
        image: imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', `rm -rf '/host-imagecache/${dataDirHash()}'`],
        volumeMounts: [{ name: 'imagecache', mountPath: '/host-imagecache' }],
      }],
      volumes: [{
        name: 'imagecache',
        hostPath: { path: LEGACY_IMAGE_STORE_ROOT, type: 'DirectoryOrCreate' },
      }],
    },
  }
}

/**
 * Reclaim the retired node-local image store on every node, once per
 * server start. Best-effort and idempotent: the second run finds nothing.
 * Skipped entirely when the registry mirror this needs is not in the local
 * registry yet — the next start will catch it.
 */
export async function sweepLegacyImageStore(): Promise<void> {
  if (!await registryHasTag(REGISTRY_MIRROR_TAG)) return
  const imageRef = registryRef(REGISTRY_MIRROR_TAG)
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    await runNodeWritePod(buildLegacyStoreSweepPodManifest(imageRef, node, i, runId))
      .catch((err: unknown) => {
        console.warn(`Legacy image-store sweep on ${node} failed: ${String(err)}`)
      })
  }
}

interface RawServiceList {
  items: Array<{ metadata: { labels?: Record<string, string> } }>
}

/**
 * How often one project's registry is collected. Long on purpose: a pass
 * costs the registry a restart, and what it reclaims (the previous
 * generation of each rebuilt tag) accrues over hours, not minutes.
 */
export const REGISTRY_GC_INTERVAL_MS = 6 * 60 * 60_000

/** Deadline for the collect run itself — it walks every blob in the store. */
export const REGISTRY_GC_TIMEOUT_MS = 10 * 60_000

/** Last collect per project — module state, so a server restart just
 *  means the next resync pass is eligible again. */
const lastRegistryGcMs = new Map<string, number>()

/** Test hook: forget the per-project throttle and any in-flight collect. */
export function _resetRegistryGcForTests(): void {
  lastRegistryGcMs.clear()
  inFlightCollect = null
}

/** The collect running right now, if any. One at a time across the whole
 *  install: each holds a registry in maintenance mode for minutes. */
let inFlightCollect: Promise<void> | null = null

/** Test hook: await the detached collect this pass started. */
export function _registryGcSettledForTests(): Promise<void> {
  return inFlightCollect ?? Promise.resolve()
}

interface RawRegistryPods {
  items: Array<{ spec?: { nodeName?: string } }>
}

/**
 * Start a blob reclaim in ONE project registry.
 *
 * `registry garbage-collect` is only safe when nothing can be pushing: a
 * push that has uploaded blobs but not yet its manifest looks exactly like
 * garbage, so a concurrent push can have its layers deleted underneath it.
 * Upstream's answer is "read-only mode, or not running at all" — and NOT
 * RUNNING is not an option here, because an active project's session count
 * never reaches zero, so a collect gated on idleness would never run for
 * the registries that actually grow.
 *
 * The collect therefore takes a MAINTENANCE WINDOW: the Deployment is
 * rolled with read-only maintenance on, which keeps pulls and the catalog
 * serving while pushes and deletes answer 405 (verified against this pin).
 * A salvage push or retire that lands in the window fails best-effort and
 * is retried on its next cycle — the ledger and the retired-shape memo
 * only record what actually succeeded — while pulls, which a live session
 * and its synced pods depend on, never stop working. The cost is two
 * `Recreate` rollouts: a few seconds of unavailability at each edge.
 *
 * DETACHED, one project per pass, never two at once: a collect is two
 * rollouts plus a pod run — minutes — and reconcile steps run
 * sequentially, so awaiting it here would stall every later step and every
 * later tick behind it (the same reason the image-salvage step detaches).
 */
export async function reconcileProjectRegistryGc(now = Date.now()): Promise<void> {
  if (inFlightCollect) return
  let services: RawServiceList | null
  try {
    services = await kubectlGetJson<RawServiceList>([
      'get', 'services', '-n', k8sNamespace(),
      '-l', `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()}`,
    ])
  } catch (err) {
    console.warn(`Registry GC: failed to list registries: ${(err as Error).message}`)
    return
  }
  for (const item of services?.items ?? []) {
    const slug = item.metadata.labels?.[LABEL_PROJECT]
    if (!slug) continue
    const last = lastRegistryGcMs.get(slug)
    if (last !== undefined && now - last < REGISTRY_GC_INTERVAL_MS) continue
    lastRegistryGcMs.set(slug, now)
    inFlightCollect = collectProjectRegistry(slug)
      .catch((err: unknown) => {
        console.warn(`Registry GC for ${slug} failed: ${String(err)}`)
      })
      .finally(() => { inFlightCollect = null })
    return
  }
}

/**
 * The collect itself, under the project's ensure mutex. That mutex is what
 * makes a session create safe against a running collect — and also the one
 * place a create can wait on one: worst case it blocks for the two
 * rollouts plus REGISTRY_GC_TIMEOUT_MS. At the 6h cadence that is rare,
 * but it is where the latency comes from.
 */
async function collectProjectRegistry(projectSlug: string): Promise<void> {
  await registryEnsureMutex(projectSlug, async () => {
    const name = projectRegistryName(projectSlug)
    const ns = k8sNamespace()
    const imageRef = registryRef(REGISTRY_MIRROR_TAG)
    // Resolved once, before the first rollout: a collect is two Recreate
    // rollouts of the very pod whose node the pin is read from, so
    // re-resolving between them could answer from a moment when no pod
    // exists — and re-pin the registry away from its own blobs.
    const node = await resolveRegistryNode(projectSlug)
    const roll = async (readOnly: boolean): Promise<void> => {
      await kubectlApply(
        buildProjectRegistryDeploymentManifest(projectSlug, imageRef, { readOnly, node }))
      await kubectlWithRetry([
        'rollout', 'status', `deployment/${name}`, '-n', ns, '--timeout=120s',
      ], { timeout: 130_000, maxAttempts: 2 })
    }

    await roll(true)
    try {
      // The storage is node-local, so the collect has to land on the node
      // the registry serves from. No pod at all means nothing has ever
      // served, so there is nothing to collect.
      const pods = await kubectlGetJson<RawRegistryPods>([
        'get', 'pods', '-l', registrySelector(projectSlug), '-n', ns,
      ])
      const nodeName = pods?.items?.[0]?.spec?.nodeName
      if (!nodeName) return
      const runId = crypto.randomBytes(4).toString('hex')
      const { phase, logs } = await runPodToCompletion(
        buildRegistryGcPodManifest(projectSlug, imageRef, nodeName, runId),
        { timeoutMs: REGISTRY_GC_TIMEOUT_MS, pollMs: 1000 },
      )
      if (phase !== 'Succeeded') {
        throw new Error(`collect pod did not complete (phase ${phase})`
          + (logs.trim() ? `; logs: ${logs.trim()}` : ''))
      }
      serverLog(`[server] registry gc: project=${projectSlug} ${logs.trim().split('\n').pop() ?? ''}`)
    } finally {
      // Unconditional: a failed collect must never strand the registry in
      // maintenance mode, where every salvage push would answer 405.
      await roll(false).catch((err: unknown) => {
        console.warn(`Registry GC: failed to restore ${projectSlug} to serving: ${String(err)}`)
      })
    }
  })
}

/**
 * Server-startup sweep: remove registries whose project no longer exists
 * locally. Catches `yaac project remove` runs that raced a dead cluster,
 * plus hand-deleted project dirs. Scoped to this install via the
 * registry GC label.
 */
export async function gcOrphanProjectRegistries(): Promise<void> {
  let services: RawServiceList | null
  try {
    services = await kubectlGetJson<RawServiceList>([
      'get', 'services', '-n', k8sNamespace(),
      '-l', `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()}`,
    ])
  } catch (err) {
    console.warn(`Orphan registry GC: failed to list registries: ${(err as Error).message}`)
    return
  }
  for (const item of services?.items ?? []) {
    const slug = item.metadata.labels?.[LABEL_PROJECT]
    if (!slug) continue
    const exists = await fs.access(projectDir(slug)).then(() => true).catch(() => false)
    if (exists) continue
    try {
      await removeProjectRegistry(slug)
      console.log(`Removed orphan project registry for ${slug}`)
    } catch (err) {
      console.warn(`Orphan registry GC: failed to remove ${slug}: ${(err as Error).message}`)
    }
  }
}
