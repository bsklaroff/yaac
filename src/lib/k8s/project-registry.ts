import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import {
  dataDirHash,
  execFileAsync,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'
import { LABEL_PROJECT, LABEL_SESSION_ID } from '@/lib/k8s/pods'
import { pushImageToRegistry, registryHasTag, registryRef } from '@/lib/k8s/registry'
import { imageExists } from '@/lib/container/runtime'
import { projectDir } from '@/lib/project/paths'
import { testEnv } from '@/shared/env'

/** `app` label value shared by every per-project registry pod. */
export const REGISTRY_APP_LABEL = 'yaac-registry'
/**
 * GC scope label: ties registry objects to this yaac install without
 * making them visible to the session reaper/list paths (which filter on
 * `yaac.data-dir-hash` + `yaac.session-id`).
 */
export const LABEL_REGISTRY_DATA_DIR_HASH = 'yaac.registry-data-dir-hash'
/**
 * In-cluster port of the per-project registry. Deliberately not 443/80:
 * Cilium redirects those to the proxy, whereas 5000 rides the session-egress
 * CNP's in-cluster carve-out (toEndpoints 5000/8443) straight to the registry.
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
 * under the data dir) like the shared image store: registry blob layouts
 * are hostile to virtiofs, and loss on cluster recreate only costs
 * re-pushes. Known growth tradeoff: stale content-hash tags accumulate
 * until project removal or cluster recreate (registry:2 GC wants a
 * quiesced registry, so no in-place pruning in v1).
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
 * Build the registry:2 Deployment. Plain root, no hostUsers — trusted
 * infra like the proxy. Recreate strategy: two pods would race over the
 * node-local storage hostPath during a rolling overlap.
 */
export function buildProjectRegistryDeploymentManifest(
  projectSlug: string,
  imageRef: string,
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
          containers: [
            {
              name: 'registry',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
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
      // port == targetPort: the NetworkPolicy and the session-egress CNP
      // carve-out list the post-translation port; a remap would diverge.
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
 * registry — the registry-ingress half of the carve-out (the session-egress
 * CNP's 5000 allowance is the other; neither alone admits the flow).
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
 * Deny-all egress on the registry pod: it only ever serves pushes and
 * pulls — there is nothing for it to fetch (no pull-through, no proxy
 * pseudo-session). Ingress stays unrestricted: sessions push over the
 * pod network and the node's containerd pulls from the host netns.
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

/** kind node names double as their container names under podman. */
async function listNodeNames(): Promise<string[]> {
  const list = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  return (list?.items ?? []).map((n) => n.metadata.name)
}

/**
 * Write the node containerd hosts.toml mapping the registry's svc-DNS host to
 * its live ClusterIP URL, so `kubectl run` of a pushed ref pulls straight from
 * the in-cluster registry. Same podman-exec mechanism as
 * scripts/setup-kind-cluster.sh. The node is not a cluster-DNS client, so it
 * needs the IP here; hosts.toml is read per-pull (no containerd restart) and is
 * rewritten on every ensure, so the allocator-assigned IP is always current.
 * Must run after the Service is applied (ensureProjectRegistry waits for it).
 */
export async function writeNodeRegistryHostsToml(projectSlug: string): Promise<void> {
  const host = projectRegistryHost(projectSlug)
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', projectRegistryName(projectSlug), '-n', k8sNamespace(),
  ])
  const vip = svc?.spec?.clusterIP
  if (!vip) throw new Error(`project registry Service ${projectRegistryName(projectSlug)} has no ClusterIP yet`)
  const dir = `/etc/containerd/certs.d/${host}`
  const content = `[host."http://${vip}:${PROJECT_REGISTRY_PORT}"]`
  for (const node of await listNodeNames()) {
    await execFileAsync('podman', [
      'exec', node, 'sh', '-c',
      `mkdir -p '${dir}' && printf '%s\\n' '${content}' > '${dir}/hosts.toml'`,
    ])
  }
}

/**
 * Idempotently stand up the project's registry (Deployment + Service + both
 * NetworkPolicies + node hosts.toml) and wait for it to serve. Called from
 * session-create only for `virtualCluster` sessions — nested-only sessions need
 * no registry and no carve-outs. The Service's ClusterIP is allocator-assigned
 * and never deleted, so `apply` is a no-op on it after first creation (the pin
 * and its immutable-field migration are gone).
 */
export async function ensureProjectRegistry(projectSlug: string): Promise<void> {
  const name = projectRegistryName(projectSlug)
  const ns = k8sNamespace()
  const imageRef = await ensureRegistryImage()

  await kubectlApply(buildProjectRegistryDeploymentManifest(projectSlug, imageRef))
  await kubectlApply(buildProjectRegistryServiceManifest(projectSlug))
  await kubectlApply(buildRegistrySessionsNetworkPolicyManifest(projectSlug))
  await kubectlApply(buildRegistryEgressNetworkPolicyManifest(projectSlug))
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${name}`, '-n', ns, '--timeout=120s',
  ], { timeout: 130_000, maxAttempts: 2 })
  await writeNodeRegistryHostsToml(projectSlug)
}

/**
 * Tear down a project's registry objects plus its node-side residue
 * (hosts.toml dir, storage). The delete selector includes the install
 * scope label so coexisting installs sharing a namespace never delete
 * each other's registries.
 */
export async function removeProjectRegistry(projectSlug: string): Promise<void> {
  const selector = [
    `app=${REGISTRY_APP_LABEL}`,
    `${LABEL_PROJECT}=${projectSlug}`,
    `${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()}`,
  ].join(',')
  await kubectlWithRetry([
    'delete', 'deployment,service,networkpolicy', '-l', selector,
    '-n', k8sNamespace(), '--ignore-not-found',
  ])

  const certsDir = `/etc/containerd/certs.d/${projectRegistryHost(projectSlug)}`
  const storageDir = projectRegistryStorageHostPath(projectSlug)
  for (const node of await listNodeNames()) {
    // Best-effort: the node container may be gone (cluster recreate).
    await execFileAsync('podman', [
      'exec', node, 'sh', '-c', `rm -rf '${certsDir}' '${storageDir}'`,
    ]).catch(() => { /* node-side residue is harmless */ })
  }
}

interface RawServiceList {
  items: Array<{ metadata: { labels?: Record<string, string> } }>
}

/**
 * Daemon-startup sweep: remove registries whose project no longer exists
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
