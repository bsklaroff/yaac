import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  DNS_STUB_PORT,
  NETD_APP_NAME,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_SLOTS,
  NETD_SA_NAME,
  SSH_TUNNEL_SENTINEL,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  TUNNEL_INGRESS_PORT,
  k8sNamespace,
  kubectlApply,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'
import { buildImage, contextHash, failImageBuild, finishImageBuild, registerImageBuild } from '#drivers/k8s/image-engine'
import { imageExists, pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { NETD_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#log'
import { clusterPodCidrs } from './cluster-cidrs'
import { cniVethPrefix } from './cni-adopt'

const execFileAsync = promisify(execFile)

/**
 * `yaac-netd` — the per-node DaemonSet that steers worktree egress into the
 * proxy. Two containers in the host network namespace:
 *
 *  - **netd** watches pods/Services, resolves each pod to the veth its
 *    frames arrive on, and programs one nat DNAT chain aiming that pod's
 *    443/80/ssh-sentinel egress at a node-local Envoy listener. It also
 *    renders Envoy's listener/cluster documents.
 *  - **envoy** is stock upstream Envoy, entirely driven by those files. It
 *    recovers each connection's pre-DNAT destination and forwards to the
 *    target proxy's transparent port behind a PROXY-protocol-v2 preamble
 *    carrying the real source pod IP.
 *
 * netd owns the redirect ONLY. Every allow/deny is a plain Kubernetes
 * NetworkPolicy enforced by Calico's Felix, so netd can never be the
 * reason something is permitted — and a netd that is down, late, or wrong
 * costs worktrees their egress rather than opening it (their NetworkPolicy
 * admits the node's listener ports and nothing world-ward).
 */

/**
 * Envoy, digest-pinned and mirrored into the local registry like
 * `registry:2` — the node then pulls it with no
 * upstream egress, which also keeps `cluster setup` working on a flaky or
 * offline network.
 *
 * The pin is the multi-arch INDEX digest, never one platform's child
 * manifest: a child digest mirrors that platform's bytes onto every host,
 * and a mismatched node then crashloops the sidecar on `exec format error`
 * — a failure that surfaces only as netd never going ready, since netd's
 * readiness is Envoy's config ack. `ensureEnvoyImage` re-checks the
 * mirrored architecture so a bad re-pin fails at mirror time instead.
 */
const ENVOY_VERSION = 'v1.34.0'
const ENVOY_PIN = 'sha256:45d37d848802f98a5647cb7522b4c1c42e0e0e775913d8e253ef3a5856bef986'
export const ENVOY_UPSTREAM_IMAGE = `docker.io/envoyproxy/envoy@${ENVOY_PIN}`
/**
 * The mirror tag carries the pin, so re-pinning re-mirrors: `ensureEnvoyImage`
 * short-circuits on a tag the registry already holds, and a version-only tag
 * would pin an existing install to the old bytes forever.
 */
export const ENVOY_MIRROR_TAG =
  `envoyproxy/envoy:${ENVOY_VERSION}-${ENVOY_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** podman's GOARCH name for this host — the node shares it (kind's node is a
 *  container here), so it is also the arch every mirrored image must be. */
export function hostImageArch(arch: string = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch
}

/**
 * Throw when a mirrored upstream image is built for the wrong architecture,
 * naming the likely cause (a pin that points at a child manifest rather than
 * the index). An empty/unknown `actual` is accepted — the check must never be
 * the reason a mirror fails.
 */
export function assertMirrorArch(
  image: string,
  actual: string,
  expected: string = hostImageArch(),
): void {
  if (!actual.trim() || actual.trim() === expected) return
  throw new Error(
    `${image} is a ${actual.trim()} image but this host is ${expected}. `
    + 'Pin the multi-arch index digest, not one platform\'s child manifest.',
  )
}

/** Content-hash tag of the netd image (the k8s/netd build context). */
export async function resolveNetdImageTag(image = 'yaac-netd'): Promise<string> {
  return `${image}:${await contextHash(NETD_DIR)}`
}

/**
 * Build-or-skip the netd image and return its in-cluster ref. Same shape
 * as the proxy's: the content-hash tag means an unchanged source tree is
 * a registry lookup and nothing more.
 */
export async function ensureNetdImage(
  requirePrebuilt = testEnv.requirePrebuiltImages,
): Promise<string> {
  const localTag = await resolveNetdImageTag(testEnv.netdImage)
  if (await registryHasTag(localTag)) return registryRef(localTag)

  if (!await imageExists(localTag)) {
    if (requirePrebuilt) {
      throw new Error(
        `netd image ${localTag} is missing or stale. `
        + 'Restart the test run so the global setup can rebuild it.',
      )
    }
    const id = registerImageBuild({ tag: localTag, layer: 'netd', action: 'build', reason: 'session' })
    serverLog(`[build] starting ${localTag} (netd)`)
    try {
      await buildImage(localTag, path.join(NETD_DIR, 'Dockerfile'), NETD_DIR)
      finishImageBuild(id)
    } catch (err) {
      failImageBuild(id, err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  return pushImageToRegistry(localTag)
}

/** Mirror the pinned Envoy image into the local registry. */
export async function ensureEnvoyImage(
  requirePrebuilt = testEnv.requirePrebuiltImages,
): Promise<string> {
  if (await registryHasTag(ENVOY_MIRROR_TAG)) return registryRef(ENVOY_MIRROR_TAG)
  if (!await imageExists(ENVOY_MIRROR_TAG)) {
    if (requirePrebuilt) {
      throw new Error(
        `Envoy image ${ENVOY_MIRROR_TAG} is missing. `
        + 'Restart the test run so the global setup can mirror it.',
      )
    }
    await execFileAsync('podman', ['pull', ENVOY_UPSTREAM_IMAGE], { timeout: 600_000 })
    const { stdout: arch } = await execFileAsync('podman', [
      'image', 'inspect', '--format', '{{.Architecture}}', ENVOY_UPSTREAM_IMAGE,
    ]).catch(() => ({ stdout: '' }))
    assertMirrorArch(ENVOY_UPSTREAM_IMAGE, arch)
    await execFileAsync('podman', ['tag', ENVOY_UPSTREAM_IMAGE, ENVOY_MIRROR_TAG])
  }
  return pushImageToRegistry(ENVOY_MIRROR_TAG)
}

export function buildNetdServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
  }
}

/**
 * Cluster-scoped read-only access to PODS, and nothing else — netd must see
 * every worktree pod, because a pod's veth is what it programs. Everything
 * else it reads (the proxy Service) lives in its own namespace and comes
 * from the Role below.
 *
 * Read-only: netd never writes to the API, so a compromised netd cannot
 * mutate cluster state (its privilege is on the node's netfilter).
 */
export function buildNetdClusterRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: netdClusterScopedName(), labels: netdClusterScopedLabels() },
    rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] }],
  }
}

/**
 * Namespaced read of the object that steers the selection: the proxy
 * Service, whose ClusterIP is the redirect target.
 *
 * `list`/`watch` cannot be narrowed to one name (RBAC `resourceNames` does
 * not apply to them), so this is every Service in the install namespace.
 * That namespace holds only yaac's own objects. Read-only.
 */
export function buildNetdRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
    rules: [{
      apiGroups: [''],
      resources: ['services'],
      verbs: ['get', 'list', 'watch'],
    }],
  }
}

export function buildNetdRoleBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: NETD_SA_NAME },
    subjects: [{ kind: 'ServiceAccount', name: NETD_SA_NAME, namespace: k8sNamespace() }],
  }
}

export function buildNetdClusterRoleBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: netdClusterScopedName(), labels: netdClusterScopedLabels() },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: netdClusterScopedName() },
    subjects: [{ kind: 'ServiceAccount', name: NETD_SA_NAME, namespace: k8sNamespace() }],
  }
}

/**
 * ClusterRole/Binding names are global, so they carry the install
 * namespace: the real `yaac` install and any ephemeral e2e
 * `yaac-test-<run-id>` install coexist on one cluster, each with its own
 * netd bound to its own SA.
 */
export function netdClusterScopedName(): string {
  return `${NETD_APP_NAME}-${k8sNamespace()}`
}

/**
 * Labels on netd's cluster-scoped RBAC. The install namespace is stamped
 * because these objects do NOT cascade when their namespace is deleted —
 * the e2e sweep finds an interrupted run's leftovers by it, and must be
 * able to do so without matching the real install's.
 */
export function netdClusterScopedLabels(): Record<string, string> {
  return { app: NETD_APP_NAME, 'yaac.install-namespace': k8sNamespace() }
}

export interface NetdDaemonSetOptions {
  netdImage: string
  envoyImage: string
  /** Cluster pod CIDRs — excluded from the redirect so pod-to-pod stays direct. */
  podCidrs: string[]
  /**
   * Interface-name prefix this cluster's CNI gives every workload veth.
   * `cali` wherever Calico does the IPAM; an adopted CNI may differ (see
   * cni-adopt.ts), and `--adopt-cni` verifies the value against a node's
   * real routing table before any worktree depends on it.
   */
  vethPrefix: string
}

/**
 * The DaemonSet. Notable choices, all security-relevant:
 *
 * - `hostNetwork` + `NET_ADMIN`/`NET_RAW`, NOT `privileged`. netd needs to
 *   write the node's nat table and read its routes; it does not need a
 *   privileged container, and asking for one would hand it far more than
 *   the redirect requires.
 * - The Envoy container gets NO capabilities at all. It only binds
 *   node-local ports above 1024 and dials the proxy — the listeners are
 *   plain (the redirect is DNAT, not TPROXY, so no transparent binding is
 *   involved), so an Envoy compromise yields no node privilege.
 * - Envoy waits for netd to write the bootstrap rather than racing it:
 *   its file-based xDS sources must resolve at boot, and a crash-looping
 *   Envoy would look exactly like a broken redirect.
 * - The proxy-side port numbers, the ssh sentinel and the listener range
 *   come from proxy-constants.ts via env, so they have one definition
 *   shared with the proxy and the policy builders. The range especially:
 *   the worktree NetworkPolicy admits exactly those ports, so a netd
 *   binding outside them would be unreachable by the pods it serves.
 * - Only netd carries a readiness probe. Its marker is written after the
 *   pass that confirmed Envoy is serving the current listener config on
 *   the admin socket, so netd's readiness already covers Envoy's — a
 *   separate Envoy probe would report a process, not a datapath.
 */
export function buildNetdDaemonSetManifest(opts: NetdDaemonSetOptions): Record<string, unknown> {
  const envoyDir = '/etc/yaac-envoy'
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: NETD_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: NETD_APP_NAME },
    },
    spec: {
      selector: { matchLabels: { app: NETD_APP_NAME } },
      template: {
        metadata: { labels: { app: NETD_APP_NAME } },
        spec: {
          hostNetwork: true,
          dnsPolicy: 'ClusterFirstWithHostNet',
          serviceAccountName: NETD_SA_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          // Trusted yaac infra: runc, like the proxy (see gvisor.ts).
          // Must also run on a control-plane-only cluster, hence the
          // blanket toleration — a node with no netd has no worktree
          // egress at all.
          tolerations: [{ operator: 'Exists' }],
          priorityClassName: 'system-node-critical',
          containers: [
            {
              name: 'netd',
              image: opts.netdImage,
              imagePullPolicy: 'IfNotPresent',
              securityContext: {
                runAsUser: 0,
                capabilities: { add: ['NET_ADMIN', 'NET_RAW'] },
              },
              env: [
                { name: 'YAAC_NAMESPACE', value: k8sNamespace() },
                { name: 'CLUSTER_POD_CIDRS', value: opts.podCidrs.join(',') },
                { name: 'NETD_VETH_PREFIX', value: opts.vethPrefix },
                { name: 'NETD_LISTENER_PORT_BASE', value: String(NETD_LISTENER_PORT_BASE) },
                { name: 'NETD_LISTENER_SLOTS', value: String(NETD_LISTENER_SLOTS) },
                { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
                { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
                { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
                { name: 'TUNNEL_INGRESS_PORT', value: String(TUNNEL_INGRESS_PORT) },
                { name: 'SSH_TUNNEL_SENTINEL', value: SSH_TUNNEL_SENTINEL },
                { name: 'DNS_STUB_PORT', value: String(DNS_STUB_PORT) },
                { name: 'NETD_ENVOY_DIR', value: envoyDir },
                {
                  name: 'NODE_NAME',
                  valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } },
                },
                // The DNAT target: this node, where the Envoy container
                // below binds its listeners.
                {
                  name: 'NODE_IP',
                  valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } },
                },
              ],
              // Ready means "the redirect is programmed", not merely "the
              // process started": netd writes this marker only after a
              // reconcile reaches the dataplane and removes it on failure.
              // Without that distinction a netd failing every pass still
              // reports Ready and the cluster-check datapath gate passes on
              // a cluster with no working worktree egress.
              readinessProbe: {
                exec: { command: ['test', '-f', `${envoyDir}/.ready`] },
                periodSeconds: 5,
                failureThreshold: 3,
              },
              volumeMounts: [{ name: 'envoy-config', mountPath: envoyDir }],
            },
            {
              name: 'envoy',
              image: opts.envoyImage,
              imagePullPolicy: 'IfNotPresent',
              securityContext: {
                runAsUser: 0,
                capabilities: { drop: ['ALL'] },
              },
              command: ['sh', '-c',
                `while [ ! -f ${envoyDir}/bootstrap.yaml ]; do sleep 0.2; done; `
                + `exec envoy -c ${envoyDir}/bootstrap.yaml --log-level warn `
                // Several installs (the real one plus an e2e run's) put a
                // hostNetwork Envoy on the same node, and they would all
                // claim base-id 0's shared-memory domain socket. Let each
                // pick a free one instead.
                + '--use-dynamic-base-id',
              ],
              volumeMounts: [{ name: 'envoy-config', mountPath: envoyDir }],
            },
          ],
          volumes: [{ name: 'envoy-config', emptyDir: {} }],
        },
      },
    },
  }
}

/**
 * Stand up (or converge) netd.
 *
 * Called from `ensureProxyResources`, so the redirect layer exists before any
 * worktree pod can be scheduled.
 */
export async function ensureNetd(): Promise<void> {
  const [netdImage, envoyImage, podCidrs] = await Promise.all([
    ensureNetdImage(),
    ensureEnvoyImage(),
    clusterPodCidrs(),
  ])
  await kubectlApply(buildNetdServiceAccountManifest())
  await kubectlApply(buildNetdClusterRoleManifest())
  await kubectlApply(buildNetdClusterRoleBindingManifest())
  await kubectlApply(buildNetdRoleManifest())
  await kubectlApply(buildNetdRoleBindingManifest())
  await kubectlApply(buildNetdDaemonSetManifest({
    netdImage, envoyImage, podCidrs, vethPrefix: cniVethPrefix(),
  }))
  await kubectlWithRetry([
    'rollout', 'status', `daemonset/${NETD_APP_NAME}`,
    '-n', k8sNamespace(), '--timeout=180s',
  ], { timeout: 190_000, maxAttempts: 2 })
}
