import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import {
  LABEL_PROJECT,
  LABEL_WORKTREE_ID,
  PRIORITY_CLASS_INFRA,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { missingPrebuiltImage } from '#drivers/k8s/image-engine'
import { registryHasTag, registryRef } from '#drivers/k8s/container'
import { nodeIpBlocks } from './cluster-cidrs'
import { projectDir } from '@yaac/shared/project-paths'
import { serverLog } from '#log'

/** `app` label value shared by every per-project registry pod. */
export const REGISTRY_APP_LABEL = 'yaac-registry'
/**
 * GC scope label: ties registry objects to this yaac install without
 * making them visible to the worktree reaper/list paths (which filter on
 * `yaac.data-dir-hash` + `yaac.worktree-id`).
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
 * worktrees NetworkPolicy straight to the registry, un-MITM'd.
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
 * FQDN, not the `.svc` shorthand: worktrees resolve it through the proxy's
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
 * PVC backing this project's registry storage. Per project, and named off
 * `projectRegistryName` so it inherits that name's install scoping and its
 * DNS-label budget (prefix + slug≤21 + hash8 + `-storage` stays well under
 * 63 chars). Growth is bounded by reconcileProjectRegistryGc, which
 * reclaims the blobs behind manifests no tag points at; live tags are never
 * collected, so a project that keeps minting NEW tags (content-hash image
 * chains) still grows until it is removed.
 */
export function projectRegistryPvcName(projectSlug: string): string {
  return `${projectRegistryName(projectSlug)}-storage`
}

/**
 * Requested capacity — one project's image chain and its worktrees' salvaged
 * layers, so a fraction of the main registry's. As with that one it is a
 * request, not a cap anything here enforces: kind's local-path provisioner
 * ignores the number, and the real bound on the local backend is the
 * collect below. On a cloud provisioner it is a real allocation, PER
 * PROJECT, against block-storage cost and quota.
 *
 * Raising it is safe; LOWERING it is not. The claim is re-applied on every
 * ensure and `spec.resources.requests.storage` is immutable except for
 * expansion, so a smaller number here makes every subsequent ensure fail at
 * the apply on installs that already bound the larger one. Shrinking means
 * a migration, not an edit. Same for MAIN_REGISTRY_STORAGE_SIZE.
 */
export const PROJECT_REGISTRY_STORAGE_SIZE = '50Gi'

/**
 * registries.conf.d drop-in making user-driven `docker push` from a
 * worktree accept the registry's plain HTTP. Written into the worktree at
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

/**
 * The blob store's claim. No `storageClassName`, so it binds through the
 * cluster's default class — see the main registry's PVC builder for why
 * naming one would be wrong.
 *
 * RWO is enough: `replicas: 1` + `Recreate` gives one mounter at a time by
 * construction. It still admits a SECOND pod on the same node, which is
 * what lets the collect pod below mount the store beside the serving
 * registry instead of having to stop it.
 *
 * Losing the volume is not symmetric with the main registry's: the
 * cross-worktree layer cache refills by rebuild, but anything a worktree
 * `docker push`ed here under a name yaac never mints is not regenerable and
 * goes with it.
 */
export function buildProjectRegistryPvcManifest(projectSlug: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: projectRegistryPvcName(projectSlug),
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: PROJECT_REGISTRY_STORAGE_SIZE } },
    },
  }
}

/**
 * Build the registry:2 Deployment. Trusted infra like the proxy, so no
 * runtimeClassName — it runs on runc; the sentry buys no containment for
 * yaac-shipped code and its CPU cost starves the node (see the gvisor.ts
 * module doc). Recreate strategy: a rolling overlap would put two pods on
 * one store, and on a backend that enforces RWO across nodes it would
 * deadlock on the old pod's volume.
 *
 * Unpinned: the blobs live on the PVC, so wherever the scheduler puts the
 * pod is where the catalog is. Placement is still constrained where it has
 * to be — a bound volume carries its own node affinity, which the scheduler
 * enforces without anything here having to name a node.
 *
 * Declaring no `tolerations` is load-bearing, not an omission, and it is
 * what keeps this off a tainted worktrees pool. That used to be hand-computed
 * by the node-resolver this replaced (matching each node's taints against an
 * empty toleration set); with the pin gone the scheduler does the same
 * matching natively, and for the same reason: the pool's toleration lives on
 * the gvisor RuntimeClass, which this trusted-infra pod deliberately does
 * not name. Under `WaitForFirstConsumer` the volume is then provisioned to
 * follow that choice, so the exclusion holds for the store's whole life, not
 * just its first placement.
 */
export function buildProjectRegistryDeploymentManifest(
  projectSlug: string,
  imageRef: string,
  opts: { readOnly?: boolean } = {},
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
          // Infra tier: the project's worktrees pull their images from here,
          // so evicting it to make room for a worktree is backwards.
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
              // this project's own worktrees can reach it.
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
              persistentVolumeClaim: { claimName: projectRegistryPvcName(projectSlug) },
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
      // Allocator-assigned (no longer pinned): worktrees resolve the live
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
 * NetworkPolicy admitting this project's worktrees to this project's
 * registry — the SOLE egress hole for worktree→registry traffic:
 * NetworkPolicy unions allow rules, so this punches an exactly-scoped
 * hole through the worktree-egress policy's default-deny (which itself has
 * no in-cluster registry allowance — an install-wide rule there could
 * not express "same project only"; see that builder's comment).
 * Per-project rather than shared because registry:2 has no path ACLs: a
 * shared writable registry
 * would let any worktree overwrite another project's (or the infra) tags.
 * The worktree-id Exists term keeps the policy off the registry pod
 * itself (it carries the project label too).
 */
export function buildRegistryWorktreesNetworkPolicyManifest(
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
        matchExpressions: [{ key: LABEL_WORKTREE_ID, operator: 'Exists' }],
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
 * legitimate clients: same-project worktree pods pushing on 5000, and the
 * NODE — the kubelet readiness probe plus containerd pulling pushed refs
 * from the host netns via hosts.toml. The worktrees policy above already
 * stops other projects' worktrees at their source; this is the
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
              matchExpressions: [{ key: LABEL_WORKTREE_ID, operator: 'Exists' }],
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
 * pseudo-worktree). Ingress is locked separately by
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
 * Scaffolding shared by the one-shot pods that replaced the old `podman
 * exec <node>` writes: node files are written by a pod that hostPath-mounts
 * the target directory, so the server never assumes the node is a container
 * on its own podman engine. Plain root like the registry itself,
 * `restartPolicy: Never` — the caller polls it to a terminal phase and
 * deletes it. Names carry a per-run random suffix so two runs can never
 * fight over one pod name (delete each other's pod mid-poll); strays from
 * crashed runs are reaped by label — the `LABEL_NODE_WRITE` sweep before
 * each hosts write, and `removeProjectRegistry`'s by-selector delete. It
 * reuses the registry:2 mirror image (already in the local registry, and on
 * the node once the registry Deployment has rolled out), and its registry
 * labels both put it under the deny-all egress NetworkPolicy (it needs no
 * network) and inside the removal selector's scope.
 *
 * `nodeName` is the whole point for the pods that touch a specific node's
 * filesystem, and the blanket toleration below is what makes it work: the
 * pin bypasses the SCHEDULER, but kubelet still admits and the taint manager
 * still evicts, so a `NoExecute` pool taint would deny those pods the very
 * nodes they must write. The collect pod passes null and an `affinity`
 * instead — see `buildRegistryGcPodManifest` for why it has to go through
 * the scheduler.
 *
 * The collect pod inherits that blanket toleration even though it IS
 * scheduled, which is harmless rather than sloppy: its required podAffinity
 * ties it to the registry pod, and the registry declares no tolerations, so
 * the only node satisfying the term is one no taint blocked anyway.
 */
function buildNodeWritePodManifest(
  projectSlug: string,
  kind: 'hosts' | 'cleanup' | 'gc',
  name: string,
  nodeName: string | null,
  imageRef: string,
  script: string,
  volumes: Array<Record<string, unknown>>,
  volumeMounts: Array<{ name: string; mountPath: string }>,
  affinity?: Record<string, unknown>,
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
      ...(nodeName ? { nodeName } : {}),
      ...(affinity ? { affinity } : {}),
      // Trusted infra (runs a fixed yaac-authored script) — no
      // runtimeClassName, so it runs on runc like the proxy and registry.
      restartPolicy: 'Never',
      // Tolerates everything, like netd and the gVisor installer. `nodeName`
      // bypasses the SCHEDULER, so NoSchedule never mattered — but kubelet
      // admits and the taint manager evicts, so a NoExecute taint would
      // refuse this pod on the very nodes it exists to write to: a tainted
      // worktrees pool would get no hosts.toml, and its worktrees could not
      // pull. Free in scheduling terms — the pod is pinned to one named node
      // and lives for seconds.
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // Infra tier: a worktree pod filling the one node this can land on
      // must not keep the registry wiring from landing.
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
 * One-shot pod removing this project's node-side residue: the registry's
 * `certs.d` directory. Unlike the writer it mounts the PARENT directory —
 * removing the child dir itself (not just its contents) requires it,
 * matching what `podman exec rm -rf` did. A wider mount than the writer's,
 * but the pod lives for seconds and runs only at project removal.
 *
 * The blobs are NOT its business: they are on a PVC, which
 * `removeProjectRegistry`'s by-selector delete takes with everything else.
 * A `hosts.toml` mapping is the only thing this project ever wrote outside
 * the API server.
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
    `rm -rf '/host-certs/${projectRegistryHost(projectSlug)}'`,
    [{
      name: 'certs',
      hostPath: { path: '/etc/containerd/certs.d', type: 'DirectoryOrCreate' },
    }],
    [{ name: 'certs', mountPath: '/host-certs' }],
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
 * rollback" covers it, whereas a project registry serves every worktree at
 * once and each worktree on its own branch mints its own hash. The live set
 * is therefore as wide as the fleet, not one deep — keep enough that a
 * parallel worktree's image is never the thing retention evicts.
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
 *    registry names one — so a worktree's own `myapp` repo is never
 *    touched;
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
 * One-shot pod reclaiming a project's registry blobs: retire stale
 * content-hash generations, then `registry
 * garbage-collect --delete-untagged` against the storage PVC with the
 * registry's own binary and stock config.
 *
 * It mounts the SAME claim the registry Deployment holds — which is what
 * makes the read-only maintenance window meaningful: it collects the store
 * that is being served, not a copy. RWO permits the second mounter only on
 * the node that already has the volume (RWO is node-scoped, unlike
 * ReadWriteOncePod), so co-location is a correctness requirement, not an
 * optimization.
 *
 * A required podAffinity on the registry pod's own labels is what states
 * that. Relying on the bound volume to imply it would only hold on
 * volume-affine backends: kind's local-path PV carries node affinity, but a
 * network-attached CSI volume typically carries none, and the scheduler does
 * not enforce RWO co-location for CSI volumes at scheduling time — the
 * conflict would surface at attach as a Multi-Attach error, after which this
 * pod sits in ContainerCreating for the full REGISTRY_GC_TIMEOUT_MS and blob
 * reclaim quietly stops on exactly the multi-node clusters the PVC is for.
 * `nodeName` cannot express it either: it bypasses the scheduler, so it
 * would just as happily bind the pod somewhere the volume cannot follow.
 *
 * `--delete-untagged` is what makes this worth running at all. Both image
 * flows into this registry REUSE tags — the image cache pushes
 * `<repo>:<tag>` and `<repo>:yaac-cache-<tag>-<n>` under the names the
 * worktree already had, and a rebuilt tag re-points at fresh bytes — so
 * every rebuild leaves the previous manifest referenced by no tag at all.
 * Those are exactly the manifests this deletes, and their blobs go with
 * them. The retention pass above is what feeds it the one class of
 * garbage it could not otherwise see.
 */
export function buildRegistryGcPodManifest(
  projectSlug: string,
  imageRef: string,
  runId: string,
): Record<string, unknown> {
  return buildNodeWritePodManifest(
    projectSlug,
    'gc',
    `${projectRegistryName(projectSlug)}-gc-${runId}`,
    null,
    imageRef,
    // Retention first: it untags the generations the collect then reclaims.
    `${buildRegistryRetentionScript()}\n`
    + `/bin/registry garbage-collect --delete-untagged=true ${GC_CONFIG_PATH}`,
    [{
      name: 'storage',
      persistentVolumeClaim: { claimName: projectRegistryPvcName(projectSlug) },
    }],
    [{ name: 'storage', mountPath: GC_STORAGE_PATH }],
    {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [{
          // `registryLabels` rather than a hand-listed app+project pair, so
          // the install scope travels with it: two installs sharing a
          // namespace can hold the same project slug, and matching without
          // the data-dir hash would let one install's collect become affine
          // to the OTHER's registry pod — a node its own volume is not on,
          // which is precisely the Multi-Attach stall this exists to
          // prevent. The pod template stamps exactly these three.
          //
          // The node-write marker must be ABSENT, or the term would also be
          // satisfied by a sibling one-shot pod (a hosts writer, another
          // run's collect) — all of which carry the same registry labels and
          // none of which implies the volume is on that node.
          labelSelector: {
            matchLabels: registryLabels(projectSlug),
            matchExpressions: [{ key: LABEL_NODE_WRITE, operator: 'DoesNotExist' }],
          },
          topologyKey: 'kubernetes.io/hostname',
        }],
      },
    },
  )
}

/**
 * The registry:2 mirror's in-cluster ref, from the registry. The mirror is
 * what lets a node pull the image with zero upstream egress at pod-create
 * time; `yaac cluster install` is what puts it there.
 */
export async function ensureRegistryImage(): Promise<string> {
  if (await registryHasTag(REGISTRY_MIRROR_TAG)) return registryRef(REGISTRY_MIRROR_TAG)
  throw missingPrebuiltImage('Registry', REGISTRY_MIRROR_TAG)
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
/**
 * The registry Service's live ClusterIP, or null when it has none yet (or
 * the cluster is unreachable). The allocator assigns it and nothing ever
 * pins it, so every consumer that cannot use cluster DNS — the node's
 * containerd hosts.toml below, and the hostNetwork'd image-store builder —
 * has to read it fresh rather than remember one.
 */
export async function projectRegistryClusterIp(projectSlug: string): Promise<string | null> {
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', projectRegistryName(projectSlug), '-n', k8sNamespace(),
  ]).catch(() => null)
  return svc?.spec?.clusterIP ?? null
}

export async function writeNodeRegistryHostsToml(projectSlug: string): Promise<void> {
  const vip = await projectRegistryClusterIp(projectSlug)
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
 * Idempotently stand up the project's registry (PVC + Deployment + Service
 * + the network policies + node hosts.toml) and wait for it to serve. Called from
 * worktree-create for every `nestedContainers` worktree — it is the bus the
 * cross-worktree image cache rides. The Service's ClusterIP is allocator-assigned and never
 * deleted, so `apply` is a no-op on it after first creation (the pin and its
 * immutable-field migration are gone).
 *
 * Serialized per project: concurrent creates on one project are routine
 * (a user create racing a prewarm spare spawn and queued yaac-mama
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

    // The claim first, so the Deployment's pod never spends the rollout
    // wait Pending on a volume that does not exist yet.
    await kubectlApply(buildProjectRegistryPvcManifest(projectSlug))
    await kubectlApply(buildProjectRegistryDeploymentManifest(projectSlug, imageRef))
    await kubectlApply(buildProjectRegistryServiceManifest(projectSlug))
    await kubectlApply(buildRegistryWorktreesNetworkPolicyManifest(projectSlug))
    await kubectlApply(buildRegistryIngressNetworkPolicyManifest(projectSlug, await nodeIpBlocks()))
    await kubectlApply(buildRegistryEgressNetworkPolicyManifest(projectSlug))
    try {
      await kubectlWithRetry([
        'rollout', 'status', `deployment/${name}`, '-n', ns, '--timeout=120s',
      ], { timeout: 130_000, maxAttempts: 2 })
    } catch (err) {
      // Worktree create is where a storage misconfiguration surfaces first,
      // and kubectl reports only a timeout. An unbindable claim — no default
      // StorageClass, or an exhausted provisioner quota — presents as a
      // Pending pod with no scheduling reason of its own, so the PVC has to
      // be named alongside the pods for the diagnosis to be one command.
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n`
        + `Inspect with \`kubectl -n ${ns} get pods,pvc -l ${registrySelector(projectSlug)}\` — `
        + 'a Pending PVC means the cluster has no default StorageClass to bind '
        + 'it, or the provisioner refused the request.',
      )
    }
    await writeNodeRegistryHostsToml(projectSlug)
  })
}

/**
 * Tear down a project's registry objects — including the PVC its blobs live
 * on, which is what reclaims the storage — plus its node-side residue (the
 * hosts.toml dir) via one-shot cleanup pods. The delete selector includes
 * the install scope label so coexisting installs sharing a namespace never
 * delete each other's registries; `pod` is in the kinds so stray
 * writer/cleanup pods from crashed runs are reaped.
 */
export async function removeProjectRegistry(projectSlug: string): Promise<void> {
  const selector = registrySelector(projectSlug)

  // Node-side residue exists only if the registry itself ever did (the
  // hosts.toml dir is written by the hosts writer). Probe before deleting
  // and skip the cleanup pods for registry-less projects: their cleanup pod
  // can't even start — the mirror image was never pushed — so each one
  // would sit Pending for runNodeWritePod's full 60s deadline, stalling
  // every project remove.
  const existing = await kubectlGetJson<{ items?: unknown[] }>([
    'get', 'deployment,service', '-l', selector, '-n', k8sNamespace(),
  ])
  const hadRegistry = (existing?.items?.length ?? 0) > 0

  // The PVC goes with the rest. Deleting it while the Deployment's pod
  // still holds it is fine — pvc-protection keeps it Terminating until the
  // last mounter is gone, and that mounter is being deleted in this same
  // call.
  await kubectlWithRetry([
    'delete', 'deployment,service,networkpolicy,persistentvolumeclaim,pod', '-l', selector,
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
  if (!hadRegistry) return

  const imageRef = registryRef(REGISTRY_MIRROR_TAG)
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    // Best-effort: the cluster may be recreated or unreachable, in which
    // case the hosts.toml went with the node it was written on.
    await runNodeWritePod(buildRegistryCleanupPodManifest(projectSlug, imageRef, node, i, runId))
      .catch(() => { /* node-side residue is harmless */ })
  }
}

interface RawServiceList {
  items: Array<{ metadata: { labels?: Record<string, string>; creationTimestamp?: string } }>
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
 *  means a registry that is already older than the interval is eligible
 *  again on the next resync pass. */
const lastRegistryGcMs = new Map<string, number>()

/**
 * When this project's registry last had nothing to collect: its previous
 * collect, or — for one this process has not collected yet — the moment
 * the Service came into being.
 *
 * The creation time is the load-bearing half. Garbage here is the
 * PREVIOUS generation of a rebuilt tag, so a registry accrues none until
 * something is rebuilt through it, and a registry younger than the
 * interval cannot have accrued a window's worth however busy it has been.
 * Without that baseline the throttle measures this process's uptime
 * instead, and an unseen slug is eligible immediately — which puts a
 * maintenance window (two `Recreate` rollouts, a few seconds of connection
 * refusals each) on the registry a worktree create JUST stood up, at the
 * one moment the new worktree is pushing and pulling through it hardest.
 * The registry's own age is the honest measure, and it survives the server
 * restart the map does not: a registry that really is due is still due on
 * the first pass after one.
 *
 * A Service with no parseable creationTimestamp (nothing a real API server
 * returns) falls back to "eligible", the pre-baseline behavior.
 */
function gcBaselineMs(projectSlug: string, creationTimestamp?: string): number {
  const collected = lastRegistryGcMs.get(projectSlug)
  if (collected !== undefined) return collected
  const created = Date.parse(creationTimestamp ?? '')
  return Number.isNaN(created) ? 0 : created
}

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

/**
 * Start a blob reclaim in ONE project registry.
 *
 * `registry garbage-collect` is only safe when nothing can be pushing: a
 * push that has uploaded blobs but not yet its manifest looks exactly like
 * garbage, so a concurrent push can have its layers deleted underneath it.
 * Upstream's answer is "read-only mode, or not running at all" — and NOT
 * RUNNING is not an option here, because an active project's worktree count
 * never reaches zero, so a collect gated on idleness would never run for
 * the registries that actually grow.
 *
 * The collect therefore takes a MAINTENANCE WINDOW: the Deployment is
 * rolled with read-only maintenance on, which keeps pulls and the catalog
 * serving while pushes and deletes answer 405 (verified against this pin).
 * A salvage push or retire that lands in the window fails best-effort and
 * is retried on its next cycle — the ledger and the retired-shape memo
 * only record what actually succeeded — while pulls, which a live worktree
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
    if (now - gcBaselineMs(slug, item.metadata.creationTimestamp)
      < REGISTRY_GC_INTERVAL_MS) continue
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
 * makes a worktree create safe against a running collect — and also the one
 * place a create can wait on one: worst case it blocks for the two
 * rollouts plus REGISTRY_GC_TIMEOUT_MS. At the 6h cadence that is rare,
 * but it is where the latency comes from.
 */
async function collectProjectRegistry(projectSlug: string): Promise<void> {
  await registryEnsureMutex(projectSlug, async () => {
    const name = projectRegistryName(projectSlug)
    const ns = k8sNamespace()
    const imageRef = registryRef(REGISTRY_MIRROR_TAG)
    const roll = async (readOnly: boolean): Promise<void> => {
      await kubectlApply(
        buildProjectRegistryDeploymentManifest(projectSlug, imageRef, { readOnly }))
      await kubectlWithRetry([
        'rollout', 'status', `deployment/${name}`, '-n', ns, '--timeout=120s',
      ], { timeout: 130_000, maxAttempts: 2 })
    }

    await roll(true)
    try {
      // The collect pod names no node: it mounts the same PVC the registry
      // does, and the bound volume's affinity is what lands it beside the
      // pod that just rolled out. The read-only rollout above is also what
      // guarantees the claim exists by here.
      const runId = crypto.randomBytes(4).toString('hex')
      const { phase, logs } = await runPodToCompletion(
        buildRegistryGcPodManifest(projectSlug, imageRef, runId),
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
