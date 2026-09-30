/**
 * The yaac server, as a workload of the cluster it manages.
 *
 * Under this driver the server is not a process beside the cluster but a
 * single-replica Deployment inside it (docs/server-in-cluster.md), which is
 * what lets server and workspace pods eventually share one claim instead of
 * one host filesystem. Everything that puts it there lives here: its image,
 * its RBAC, its Deployment, the ingress policies that are the only thing
 * between an untrusted workspace pod and an unauthenticated API, and the
 * `server.json` that points every client at the published origin. What
 * fronts its Service — how the origin is reached from outside the cluster
 * — is the one per-backend piece, and it is handed in as a
 * `ServerFronting` (server-fronting.ts) rather than decided here.
 *
 * Install-only, like the rest of this folder. The server never applies its
 * own Deployment — a workload that rolls itself is a workload that can roll
 * itself into a state it cannot roll back out of.
 *
 * The pod's storage is the three tiers as three mounts (storage.ts): the
 * `yaac-global` and `yaac-server-local` claims and the node's own
 * node-local tree, at fixed pod paths the Deployment names in the three
 * root variables. `YAAC_DATA_DIR` keeps naming the host's data dir, as an
 * identity string: `dataDirHash()`, every label and every row carry over.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  GLOBAL_CLAIM_NAME,
  LABEL_DATA_DIR_HASH,
  LABEL_INSTALL_ID,
  LABEL_INSTALL_NAMESPACE,
  POD_GLOBAL_ROOT,
  POD_NODE_LOCAL_ROOT,
  POD_SERVER_LOCAL_ROOT,
  PRIORITY_CLASS_INFRA,
  RELAY_PORT,
  SERVER_APP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  SERVER_POD_PORT,
  SERVER_SA_NAME,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  installSecurityContext,
  nodeLocalNodePath,
  processIdentity,
  proxyServiceHost,
  type InstallIdentity,
} from '#drivers/k8s/substrate'
import { ensureStorageClaims, type StorageShape } from './storage'
import {
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  nodeIpBlocks,
} from '#drivers/k8s/cluster'
import { frontingOfIngress, type RemoteHosting, type ServerFronting } from './server-fronting'
import {
  contextHash,
  ensureImageByTag,
  stringHash,
} from '#drivers/k8s/image-engine'
import { pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
// The install root itself, not a place to put bytes: the pod is handed it
// as `YAAC_DATA_DIR` so its identity (`dataDirHash()`, every label) is the
// host's; what it MOUNTS are the three tier roots.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { getDataDir, globalRoot, nodeLocalRoot, serverLocalRoot, serverLogPath } from '@yaac/shared/paths'
import { readLock } from '@yaac/shared/lock'
import { isLockLive, isSameHostLock } from '@yaac/shared/server-lock-file'
import {
  IdentityRejectedError,
  probeServer,
  registerServer,
} from '@yaac/shared/server-config'
import { env, testEnv } from '@yaac/shared/env'

/**
 * Build context of the server image: the BUNDLE, not the source tree.
 *
 * `dist/` is the only directory the npm tarball ships and the only place
 * the server exists as a single runnable artifact, so it is both what the
 * image needs to contain and what its content hash should be taken over. In
 * the bundle `PACKAGE_ROOT` already IS that directory; from a source
 * checkout it is the repo root, and `dist/` under it is what `pnpm build`
 * produces — so a dev who has not built yet gets a missing-Dockerfile error
 * naming the build rather than an image of a stale tree.
 */
export function serverImageContext(): string {
  return env.bundled ? PACKAGE_ROOT : path.join(PACKAGE_ROOT, 'dist')
}

function serverDockerfile(context = serverImageContext()): string {
  return path.join(context, 'dockerfiles', 'Dockerfile.server')
}

/**
 * The server image's tag: the content hash of the bundle it contains.
 *
 * Same contract as every other yaac-shipped image — an unchanged bundle
 * costs one registry HEAD, and a rebuilt one is a different image, which is
 * exactly the signal the Deployment rolls on. Content only, no uid: the
 * image is uid-agnostic (docs/arbitrary-uid-images.md), so the tag a host
 * finds in the registry is always an image it can run.
 */
export async function resolveServerImageTag(
  context = serverImageContext(),
  prefix = testEnv.imagePrefix ?? 'yaac',
): Promise<string> {
  return `${prefix}-server:${stringHash(await contextHash(context))}`
}

/**
 * Build (or skip) the server image and push it to the cluster registry.
 *
 * `context` names the bundle to package, and defaults to this install's own.
 * The e2e tiers pass their frozen copy of it instead (`dist-test/`), because
 * a suite that hashed the live `dist/` would re-tag mid-run the moment `pnpm
 * watch` rebuilt it — the same reason the CLI those suites spawn is a
 * snapshot; they name their image prefix outright for the same reason, since
 * the process that BUILDS it and the process that looks it up are different
 * ones and only one of them has the suite's env.
 */
export async function ensureServerImage(
  context = serverImageContext(),
  prefix = testEnv.imagePrefix ?? 'yaac',
): Promise<string> {
  const tag = await resolveServerImageTag(context, prefix)
  if (await registryHasTag(tag)) return registryRef(tag)
  const dockerfile = serverDockerfile(context)
  try {
    await fs.access(dockerfile)
  } catch {
    throw new Error(
      `no server build context at ${context} — the server image is `
      + 'built from the bundle. Run `pnpm build` first (from a source checkout); '
      + 'an npm install ships one already.',
    )
  }
  await ensureImageByTag(tag, dockerfile, context)
  return pushImageToRegistry(tag)
}

/** Every pod of the server carries the install identity, like the proxy's. */
function serverPodLabels(): Record<string, string> {
  return { app: SERVER_APP_NAME, [LABEL_DATA_DIR_HASH]: dataDirHash() }
}

/**
 * ServiceAccount the server acts as. Unlike the proxy's, this identity is
 * the yaac control plane — it creates workspace Jobs, applies the datapath,
 * and stands per-project registries up in namespaces of their own.
 */
export function buildServerServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name: SERVER_SA_NAME,
      namespace: k8sNamespace(),
      labels: { app: SERVER_APP_NAME },
    },
  }
}

/**
 * Name of the server's ClusterRole and ClusterRoleBinding.
 *
 * Namespace-suffixed for the same reason netd's are: cluster-scoped objects
 * do not belong to a namespace, and one cluster hosts more than one install
 * — the real `yaac` one, plus an ephemeral `yaac-test-<run-id>` per e2e
 * file. A shared name would have the last applier own everyone's binding.
 */
export function serverClusterScopedName(): string {
  return `${SERVER_SA_NAME}-${k8sNamespace()}`
}

/**
 * Labels on the server's cluster-scoped RBAC. The install namespace is
 * stamped because these objects do NOT cascade when their namespace is
 * deleted, so the e2e sweep needs a way to find an interrupted run's
 * leftovers without matching the real install's.
 */
export function serverClusterScopedLabels(): Record<string, string> {
  return { app: SERVER_APP_NAME, [LABEL_INSTALL_NAMESPACE]: k8sNamespace() }
}

/**
 * What the server is allowed to do, enumerated by resource.
 *
 * Cluster-scoped rather than a namespaced Role, and not because the server
 * is careless with namespaces: per-project registries live in namespaces
 * the server CREATES at runtime, so a binding into namespaces that exist
 * today could not cover them. The cluster-scoped objects it applies at
 * every start (PriorityClasses, RuntimeClasses, the builder-role admission
 * guard) need the same reach.
 *
 * Verbs are full on what the server owns and read-only on what it only
 * observes (nodes, events, the storage classes a registry claim binds
 * through). `roles`/`rolebindings` are here because the server applies the
 * proxy's own RBAC on start; RBAC's escalation check still binds it to
 * granting no more than it holds.
 */
export function buildServerClusterRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: serverClusterScopedName(), labels: serverClusterScopedLabels() },
    rules: [
      {
        apiGroups: [''],
        resources: [
          'pods', 'pods/exec', 'pods/log', 'pods/attach', 'pods/portforward',
          'services', 'endpoints', 'configmaps', 'secrets', 'serviceaccounts',
          'namespaces', 'persistentvolumeclaims',
        ],
        verbs: ['*'],
      },
      { apiGroups: [''], resources: ['nodes', 'events'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['apps'], resources: ['deployments', 'daemonsets', 'replicasets'], verbs: ['*'] },
      { apiGroups: ['batch'], resources: ['jobs'], verbs: ['*'] },
      { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['*'] },
      {
        // Namespaced RBAC because the server applies the proxy's own SA
        // and Role on start; the cluster-scoped pair for netd's
        // ClusterRole and binding, which it applies beside the proxy.
        apiGroups: ['rbac.authorization.k8s.io'],
        resources: ['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'],
        verbs: ['*'],
      },
      { apiGroups: ['scheduling.k8s.io'], resources: ['priorityclasses'], verbs: ['*'] },
      { apiGroups: ['node.k8s.io'], resources: ['runtimeclasses'], verbs: ['*'] },
      {
        apiGroups: ['admissionregistration.k8s.io'],
        resources: ['validatingadmissionpolicies', 'validatingadmissionpolicybindings'],
        verbs: ['*'],
      },
      {
        apiGroups: ['storage.k8s.io'],
        resources: ['storageclasses'],
        verbs: ['get', 'list', 'watch'],
      },
      {
        apiGroups: ['discovery.k8s.io'],
        resources: ['endpointslices'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  }
}

export function buildServerClusterRoleBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: serverClusterScopedName(), labels: serverClusterScopedLabels() },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: serverClusterScopedName(),
    },
    subjects: [{ kind: 'ServiceAccount', name: SERVER_SA_NAME, namespace: k8sNamespace() }],
  }
}

export interface ServerEnvOptions {
  /**
   * The host's address on the kind network, when `YAAC_USE_TOR` is set.
   * Absent leaves the configured URL alone, which is right for a Tor that
   * already listens on a routable address and wrong only for a loopback
   * one — where install has already warned.
   */
  torHostAddr?: string
  /**
   * What the fronting says the Deployment must state for the origin it
   * published — the tailnet name it admits. Unioned with what the install
   * shell already carries, never replacing it.
   */
  remoteHosting?: RemoteHosting
}

/**
 * Environment the Deployment hands the server: what it can no longer read
 * off a host, plus the host-side shims it must not take.
 *
 * `YAAC_DATA_DIR` names the same absolute path the host uses, so the
 * install's identity (`dataDirHash()`, every pod label, the DB) carries
 * over unchanged; the three root variables are where the tiers are
 * MOUNTED, which is what the path helpers resolve into inside the pod
 * (docs/server-in-cluster.md "Storage is two claims"). `YAAC_RELAY_ADDR` points
 * at the proxy Service, which deletes the stream relay's port-forward hop.
 * `YAAC_IN_CLUSTER` is what the registry client reads to dial the registry's
 * Service DNS instead of forwarding to it.
 *
 * The pass-throughs are settings that belong to the DEPLOYMENT rather than
 * to a shell: there is no shell in a pod to set them in afterwards, and the
 * datapath half (the veth prefix, the pod CIDRs) is applied by the SERVER
 * on every start, so it has to reach the pod that applies it. The cost is
 * that they arrive from whatever environment ran `yaac cluster install`.
 */
export function buildServerEnv(opts: ServerEnvOptions = {}): Array<{ name: string; value: string }> {
  const hosting = effectiveRemoteHosting(opts.remoteHosting)
  const vars: Array<{ name: string; value: string }> = [
    { name: 'YAAC_IN_CLUSTER', value: '1' },
    // A pod's loopback has no reachable backend; the ingress NetworkPolicy
    // is what takes over from the loopback bind (see policy-manifests).
    { name: 'YAAC_BIND_ADDR', value: '0.0.0.0' },
    { name: 'YAAC_SERVER_PORT', value: String(SERVER_POD_PORT) },
    { name: 'YAAC_DATA_DIR', value: getDataDir() },
    { name: 'YAAC_GLOBAL_ROOT', value: POD_GLOBAL_ROOT },
    { name: 'YAAC_SERVER_LOCAL_ROOT', value: POD_SERVER_LOCAL_ROOT },
    { name: 'YAAC_NODE_LOCAL_ROOT', value: POD_NODE_LOCAL_ROOT },
    { name: 'YAAC_DRIVER', value: 'k8s' },
    { name: 'YAAC_RELAY_ADDR', value: proxyServiceHost(k8sNamespace(), RELAY_PORT) },
  ]
  const passThrough: Array<[string, string | undefined]> = [
    ['YAAC_K8S_NAMESPACE', testEnv.k8sNamespace],
    ['YAAC_IMAGE_PREFIX', testEnv.imagePrefix],
    ['YAAC_ALLOWED_HOSTS', hosting.allowedHosts.length > 0 ? hosting.allowedHosts.join(',') : undefined],
    // The address the snapshot claims a workspace's forwarded ports answer
    // at. The server binds nothing either way, so this is a display value —
    // but it is the one a remote-hosting install must change (a tailnet IP,
    // matching `yaac forward --bind`), and the pod is where it is read.
    ['YAAC_FORWARD_BIND', env.forwardBind === '127.0.0.1' ? undefined : env.forwardBind],
    ['YAAC_USE_TOR', env.useTor ? '1' : undefined],
    // Only meaningful alongside USE_TOR, and only as an address the POD can
    // reach — `torSocksUrlForPod` rewrites the host loopback into the
    // host's address on the kind network.
    ['YAAC_HOST_TOR_SOCKS_URL', env.useTor ? torSocksUrlForPod(opts.torHostAddr) : undefined],
    // Datapath knobs the SERVER applies on every start (netd's redirect,
    // the pod-CIDR RETURNs), so they have to reach the pod that applies
    // them rather than staying in the install's shell.
    ['YAAC_CNI_VETH_PREFIX', env.cniVethPrefix],
    ['YAAC_POD_CIDRS', env.podCidrs.length > 0 ? env.podCidrs.join(',') : undefined],
    ['YAAC_KUBE_PROXY_EXTERNAL', env.kubeProxyExternal ? '1' : undefined],
    ['YAAC_E2E_SKIP_FETCH', testEnv.e2eSkipFetch ? '1' : undefined],
    // The encryption key for stored secrets, when the operator states one
    // rather than letting the server generate its own into the data dir.
    // A pod has no shell to export it in, so this is the only way it can
    // arrive — same reason as the two host-header knobs above.
    ['YAAC_SECRETS', env.secrets === null
      ? undefined
      : env.secrets.map((s) => `${String(s.version)}:${s.value}`).join(',')],
    ['YAAC_SECRET', env.secret],
  ]
  for (const [name, value] of passThrough) {
    if (value !== undefined && value !== '') vars.push({ name, value })
  }
  return vars
}

/**
 * The remote-hosting posture the Deployment ends up with: the fronting's
 * answer unioned with the install shell's. The shell half stays because it
 * is how a kind install is fronted by a host-side `tailscale serve`
 * (docs/remote-hosting.md); the fronting half is how an install that
 * publishes its own tailnet name admits it.
 */
function effectiveRemoteHosting(fromFronting: RemoteHosting = { allowedHosts: [] }): RemoteHosting {
  return { allowedHosts: [...new Set([...fromFronting.allowedHosts, ...env.allowedHosts])] }
}

/**
 * The host's Tor SOCKS endpoint, addressed from inside the cluster.
 *
 * `YAAC_USE_TOR` names a listener on the host, which for a host process
 * meant loopback. A pod's loopback is its own, so the loopback halves of
 * the URL are rewritten to the host's address on the kind network — the
 * same address the node CIDRs are derived from. Tor has to be listening on
 * that interface and not only on 127.0.0.1 — nothing here can verify that,
 * so install says so when it hands the address over, because the failure
 * otherwise surfaces as every git fetch hanging.
 */
export function torSocksUrlForPod(hostAddr?: string): string {
  const raw = env.torSocksUrl
  if (hostAddr === undefined) return raw
  try {
    const url = new URL(raw)
    // `[::1]` with the brackets, because that is what the URL parser
    // produces for an IPv6 host — comparing against a bare `::1` matches
    // nothing, and the miss is silent: the pod keeps a loopback SOCKS URL
    // and every git fetch hangs, which is the exact failure this rewrite
    // exists to prevent.
    const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1']
    if (LOOPBACK.includes(url.hostname)) {
      url.hostname = hostAddr
    }
    return url.href
  } catch {
    return raw
  }
}

/**
 * The server Deployment.
 *
 * `Recreate` at one replica, because PGlite is an embedded single-writer
 * database and two servers of one install are two writers of one directory.
 * The lock's lease is the guard that actually enforces that on kind, where
 * the RWO claim is a hostPath with no attach exclusivity to fall back on,
 * and the strategy is what keeps the lease from having to arbitrate on
 * every roll.
 *
 * Plain runc, no RuntimeClass: the server is yaac's own code, and a sentry
 * per infra pod is CPU spent on containment that buys nothing. Infra
 * priority, because a preempted server takes every workspace's control plane
 * with it.
 */
export function buildServerDeploymentManifest(
  imageRef: string,
  identity: InstallIdentity,
  envOpts: ServerEnvOptions & { installId?: string } = {},
): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: SERVER_APP_NAME,
      namespace: k8sNamespace(),
      // The install id is the record of whose Deployment this is.
      labels: { app: SERVER_APP_NAME, ...(envOpts.installId ? { [LABEL_INSTALL_ID]: envOpts.installId } : {}) },
    },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: SERVER_APP_NAME } },
      template: {
        metadata: { labels: serverPodLabels() },
        spec: {
          serviceAccountName: SERVER_SA_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          priorityClassName: PRIORITY_CLASS_INFRA,
          // The install identity, which this is the record of: every path
          // the server pre-creates for a workspace pod is owned by it, and
          // host-side callers read it back from here
          // (deployedInstallIdentity). No `fsGroup`: the claims' roots are
          // made the install's once, at install, and HOME is the image's
          // own rootfs, writable through group 0.
          securityContext: installSecurityContext(identity),
          // A rolled server should not sit in the drain while every
          // watcher's connection times out; its shutdown path is bounded to
          // ~6s by design.
          terminationGracePeriodSeconds: 30,
          containers: [
            {
              name: 'server',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              // No setuid path to real root. The server needs none — its
              // image has no sudo — and without this there is one: the pod
              // runs on plain runc in group 0 with a group-writable
              // /etc/passwd, which with ubuntu's setuid `su` and pam_unix's
              // `nullok` is enough to make the `yaac` line uid 0 with an
              // empty password and `su` over the data-dir hostPath. Workspace
              // pods are the opposite case by design: in-pod root is a
              // feature there and the gVisor sentry is the boundary.
              securityContext: { allowPrivilegeEscalation: false },
              ports: [{ containerPort: SERVER_POD_PORT }],
              env: buildServerEnv(envOpts),
              readinessProbe: {
                httpGet: {
                  path: '/api/health',
                  port: SERVER_POD_PORT,
                  // The kubelet dials the POD IP, so its Host header is the
                  // pod IP — which the server's DNS-rebind guard rejects
                  // with a 403 (only loopback and YAAC_ALLOWED_HOSTS pass,
                  // by design). Stating the header keeps that guard exactly
                  // as strict while letting the probe describe the request
                  // it is actually standing in for: a client dialing the
                  // published loopback origin.
                  httpHeaders: [{ name: 'Host', value: '127.0.0.1' }],
                },
                periodSeconds: 2,
                failureThreshold: 60,
              },
              // Memory is capped because it is not compressible and PGlite
              // holds the database in the same process; cpu deliberately is
              // not, because a CFS quota on the control plane throttles
              // every workspace's reconcile at once.
              resources: {
                requests: { cpu: '250m', memory: '1Gi' },
                limits: { memory: '6Gi' },
              },
              volumeMounts: [
                { name: 'global', mountPath: POD_GLOBAL_ROOT },
                { name: 'server-local', mountPath: POD_SERVER_LOCAL_ROOT },
                { name: 'node-local', mountPath: POD_NODE_LOCAL_ROOT },
              ],
            },
          ],
          // The three tiers (storage.ts). The claims are what install
          // bound; the node-local tree is this node's own, the same path
          // every workspace pod on the node mounts its caches under.
          volumes: [
            { name: 'global', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } },
            { name: 'server-local', persistentVolumeClaim: { claimName: SERVER_LOCAL_CLAIM_NAME } },
            { name: 'node-local', hostPath: { path: nodeLocalNodePath(), type: 'DirectoryOrCreate' } },
          ],
        },
      },
    },
  }
}

/**
 * Apply the server workload, its fronting, and wait for both to roll.
 *
 * Order matters three times: the SA and its ClusterRole exist before the
 * pod that mounts the token; both halves of the ingress wall are applied
 * before the Service publishes the port — a window in which the API is reachable from
 * pods is a window in which a workspace could use it; and the fronting is
 * applied before the Deployment, because the origin it publishes (read off
 * the Ingress on a tailnet) is an input to the Deployment's environment.
 * On an existing kind install the Service apply is also what releases the
 * old NodePort on the node before the forwarder binds it.
 *
 * Returns the published origin.
 */
export async function ensureServerDeployment(
  imageRef: string,
  fronting: ServerFronting,
  identity: InstallIdentity,
  envOpts: ServerEnvOptions & { installId?: string } = {},
): Promise<string> {
  await kubectlApply(buildServerServiceAccountManifest())
  await kubectlApply(buildServerClusterRoleManifest())
  await kubectlApply(buildServerClusterRoleBindingManifest())
  await kubectlApply(buildServerIngressNpManifest(await nodeIpBlocks()))
  await kubectlApply(buildServerFrontIngressNpManifest(fronting.ingressPeers()))
  for (const [kind, name] of fronting.retired()) {
    await kubectlWithRetry(['delete', kind, name, '-n', k8sNamespace(), '--ignore-not-found'])
  }
  const manifests = fronting.manifests()
  for (const manifest of manifests) await kubectlApply(manifest)
  const origin = await fronting.resolveOrigin()
  await kubectlApply(buildServerDeploymentManifest(imageRef, identity, {
    ...envOpts,
    remoteHosting: fronting.remoteHosting(origin),
  }))
  for (const manifest of manifests) {
    if (manifest.kind !== 'Deployment') continue
    const name = (manifest.metadata as { name: string }).name
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${name}`, '-n', k8sNamespace(), '--timeout=120s',
    ], { timeout: 130_000, maxAttempts: 2 })
  }
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
    '-n', k8sNamespace(),
    '--timeout=300s',
  ], { timeout: 310_000, maxAttempts: 2 })
  return origin
}

/** Scale the Deployment to `replicas` and wait for the change to settle. */
export async function scaleServerDeployment(replicas: number): Promise<void> {
  await kubectlWithRetry([
    'scale', `deployment/${SERVER_APP_NAME}`,
    '-n', k8sNamespace(), `--replicas=${String(replicas)}`,
  ], { timeout: 60_000 })
}

interface RawServerDeployment {
  spec?: {
    template?: {
      spec?: {
        securityContext?: { runAsUser?: unknown; runAsGroup?: unknown }
        containers?: Array<{ name?: string; image?: string }>
      }
    }
  }
}

/**
 * The uid and gid a byo install's pods run as. A constant rather than
 * the uid of the machine running install: an NFS server passes uids
 * through raw, that machine means nothing to it, and ownership has to stay
 * stable whichever machine re-installs (docs/server-in-cluster.md "The uid
 * everything runs as").
 */
export const BYO_INSTALL_IDENTITY: InstallIdentity = { uid: 1000, gid: 1000 }

/**
 * The identity this install's pods run as, as the live server Deployment
 * records it — the Deployment is the record, as the Ingress is for the
 * fronting. For the host-side callers that are not install (`cluster
 * check`'s probe pods, the e2e harness), which cannot derive it from their
 * own uid: on a byo install the machine running the CLI is not the
 * install's uid at all. With no Deployment to ask (an install that stopped
 * before its server), it is what install would have deployed: the byo
 * constant, or on kind this machine's own uid. A failed read throws rather
 * than guessing.
 */
export async function deployedInstallIdentity(byo: boolean): Promise<InstallIdentity> {
  const dep = await kubectlGetJson<RawServerDeployment>([
    'get', 'deployment', SERVER_APP_NAME, '-n', k8sNamespace(),
  ])
  const sc = dep?.spec?.template?.spec?.securityContext
  if (typeof sc?.runAsUser === 'number' && typeof sc.runAsGroup === 'number') {
    return { uid: sc.runAsUser, gid: sc.runAsGroup }
  }
  return byo ? BYO_INSTALL_IDENTITY : processIdentity()
}

/** Whether the cluster carries a server Deployment at all. */
export async function serverDeploymentExists(): Promise<boolean> {
  const dep = await kubectlGetJson<{ metadata?: { name?: string } }>([
    'get', 'deployment', SERVER_APP_NAME, '-n', k8sNamespace(),
  ])
  return dep !== null
}

/**
 * Stop the server that is there, build the image, apply the workload, wait
 * for the published origin to answer, and point this machine's clients at
 * it — the whole of "the server now runs in the cluster", as one step
 * `yaac cluster install` injects and unit tests replace.
 *
 * Returns the origin it published, which is what install prints.
 */
export async function deployServerWorkload(
  opts: ServerEnvOptions & {
    fronting: ServerFronting
    /** The uid and gid install decided this install's pods run as. */
    identity: InstallIdentity
    /** Who this install is (`server.json`'s `installId`). */
    installId: string
    /**
     * What backs the two claims: kind's static pair into this machine's
     * data dir, or the classes a byo install provisions them from.
     */
    storage: { kind: 'static' } | { kind: 'classes'; rwx: string; rwo: string }
    log: (message: string) => void
  },
): Promise<string> {
  await refuseIfHostServerRunning()
  if (await serverDeploymentExists()) {
    opts.log('Stopping the running server pod...')
    await stopClusterServer()
  }
  // The image first: the class path's binder pod runs it, and on a node-
  // pinned RWO class that pod decides the node the server lands on, so the
  // pull it pays is the server's own.
  opts.log('Building the server image (from the bundle)...')
  const imageRef = await ensureServerImage()
  const shape: StorageShape = opts.storage.kind === 'static'
    ? {
      kind: 'static',
      globalHostPath: globalRoot(),
      serverLocalHostPath: serverLocalRoot(),
      nodeLocalHostPath: nodeLocalRoot(),
    }
    : { ...opts.storage, identity: opts.identity, installId: opts.installId, binderImage: imageRef }
  await ensureStorageClaims({ shape, log: opts.log })
  opts.log(`Deploying the yaac server (${imageRef})...`)
  // Pass the options straight through rather than re-listing the fields:
  // every `ServerEnvOptions` member is optional, so a hand-copied list lets
  // the next field added go missing from the Deployment with no compile error.
  const origin = await ensureServerDeployment(imageRef, opts.fronting, opts.identity, opts)
  await waitForPublishedServer(origin, opts.fronting)
  // Point every client on this machine at the published origin, and record
  // that this data dir IS a k8s install, so a later `yaac server start`
  // from an ordinary shell finds the Deployment instead of spawning a
  // second server beside it. The registration is shared with `yaac server
  // start` — an install is not special, it just stands up a Deployment
  // instead of a process (docs/server-in-cluster.md).
  await registerServer(origin, 'k8s')
  // A fronting with no loopback path puts this machine's own CLI behind the
  // identity rule like any other device, and a tagged device has no user to
  // be. Said now rather than on the next command.
  await probeServer(origin).catch((err: unknown) => {
    if (err instanceof IdentityRejectedError) {
      opts.log(`WARNING: ${err.message}\n    The CLI on this machine cannot use this server `
        + 'until it runs as a tailnet user (docs/remote-hosting.md).')
    }
  })
  return origin
}

/**
 * Refuse to deploy the pod while a HOST server still holds this data dir.
 *
 * The documented upgrade is `npm update`, then install — run, ordinarily,
 * on an install whose server is up. Deploying into that leaves two writers
 * on one directory, and `waitForPublishedServer` would not catch it: on a
 * cluster predating the port mapping, the loopback origin it probes is
 * answered by the OLD HOST SERVER. Install would then report success and
 * write a `server.json` that points every client at the process it was
 * meant to replace — a green banner over a permanent
 * dual-writer. One refusal, before anything is applied.
 */
async function refuseIfHostServerRunning(): Promise<void> {
  const lock = await readLock()
  // An off-host lock is skipped because it is this install's own pod:
  // rolling that IS what install does, sequenced by `Recreate`.
  if (!lock || !isSameHostLock(lock) || !await isLockLive(lock)) return
  throw new Error(
    'a yaac server is already running on this data dir as a host process '
    + `(pid ${String(lock.pid)}, port ${String(lock.port)}).\n`
    + '    Deploying the server into the cluster now would put two servers on '
    + 'one database.\n'
    + '    Stop it first: `yaac server stop`, then re-run `yaac cluster install`.',
  )
}

/**
 * Wait for the ROLLED server to answer at its published origin, and turn
 * "it never does" into a diagnosis of why.
 *
 * A Deployment that is Available while the origin refuses is not a server
 * problem: on kind it is a cluster created before the port mapping existed
 * (which cannot be converged, only recreated), on a tailnet it is this
 * machine not being able to reach the name the operator published. The
 * fronting knows which, so it supplies the text. An origin that answers
 * but never with a ready server was reached, so that text is wrong for it:
 * the likeliest cause is a Deployment an older yaac installed, whose image
 * predates this CLI's routes, and `yaac cluster install` rolls the current one.
 */
async function waitForPublishedServer(origin: string, fronting: ServerFronting): Promise<void> {
  const deadline = Date.now() + fronting.publishTimeoutMs
  let last = 'no attempt made'
  let reached = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })
      reached = true
      if (res.ok) {
        const body = await res.json() as { ready?: unknown }
        if (body.ready === true) return
        last = 'answered /api/health but is still initializing'
      } else last = `answered HTTP ${String(res.status)}`
    } catch (err) {
      reached = false
      last = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (reached) {
    throw new Error(
      `the server Deployment rolled out and ${origin} answers, but not as a ready server (${last}).\n`
      + '    If an older yaac installed it, roll this bundle with `yaac cluster install`.',
    )
  }
  throw new Error(
    `the server Deployment rolled out, but ${origin} does not answer (${last}).\n`
    + `    ${fronting.unreachableDiagnosis(origin)}`,
  )
}

/**
 * The fronting this install's live Ingress records, which is what the
 * start and restart verbs wait on. Read fresh each time: nothing on disk
 * says which fronting was installed, and the cluster does.
 */
async function installedFronting(): Promise<ServerFronting> {
  const ingress = await kubectlGetJson<Record<string, unknown>>([
    'get', 'ingress', SERVER_APP_NAME, '-n', k8sNamespace(),
  ])
  return frontingOfIngress(ingress)
}

/** Wait for the installed fronting's origin to answer, and return it. */
async function waitForInstalledServer(): Promise<string> {
  const fronting = await installedFronting()
  const origin = await fronting.resolveOrigin()
  await waitForPublishedServer(origin, fronting)
  return origin
}

/**
 * `yaac server start` against an install whose server is a Deployment:
 * scale it back to one and wait, returning the origin it answers at. The
 * counterpart to `stopClusterServer`, and NOT a substitute for `yaac
 * cluster install` — it starts the server that is already deployed, it
 * does not deploy one.
 */
export async function startClusterServer(): Promise<string> {
  await deleteLogReader()
  await scaleServerDeployment(1)
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
    '-n', k8sNamespace(), '--timeout=300s',
  ], { timeout: 310_000, maxAttempts: 2 })
  return waitForInstalledServer()
}

/**
 * `yaac server stop`: scale to zero. Deleting the Deployment would be the
 * other reading of "stop", and the wrong one — it would take the RBAC and
 * the Service with it, so the thing that undid a `stop` would have to be a
 * full install rather than a `start`.
 */
export async function stopClusterServer(): Promise<void> {
  await scaleServerDeployment(0)
  // Wait on the POD going away, not on a replica count reaching zero: a
  // Deployment at zero replicas omits `status.replicas` altogether, so a
  // jsonpath wait for `=0` matches nothing and burns its whole timeout on
  // every successful stop. `--for=delete` over the selector also answers
  // instantly when there is no pod left to wait for.
  await kubectlWithRetry([
    'wait', 'pod', '-n', k8sNamespace(), '-l', `app=${SERVER_APP_NAME}`,
    '--for=delete', '--timeout=60s',
  ], { timeout: 70_000, maxAttempts: 1 }).catch(() => {
    // The scale is recorded either way; a slow drain is not a failure to
    // stop, and the lease going stale is what any successor waits on.
  })
}

/**
 * `yaac server restart`: roll the pod and return the origin it answers at.
 * `Recreate` means the old pod is gone before the new one is scheduled, so
 * the lease never has two holders.
 */
export async function restartClusterServer(): Promise<string> {
  await deleteLogReader()
  await kubectlWithRetry([
    'rollout', 'restart', `deployment/${SERVER_APP_NAME}`, '-n', k8sNamespace(),
  ], { timeout: 60_000 })
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
    '-n', k8sNamespace(), '--timeout=300s',
  ], { timeout: 310_000, maxAttempts: 2 })
  return waitForInstalledServer()
}

/**
 * `yaac server logs` on a byo install: `tail` over the log the server
 * writes into its server-local claim, which is a volume this machine never
 * sees. (A kind install's claim is a hostPath into this machine's data
 * dir, so its CLI reads the file directly, whatever state the pod is in.)
 *
 * Read in the server pod when its container is running. When it is not —
 * crash-looping, still starting, or scaled to zero, which is exactly when
 * the log is wanted — read through a short-lived reader pod that mounts the
 * claim read-only: the claim is free then, and the reader is pinned to the
 * server pod's node if there is one, where an attach-once volume already
 * is. The flags are `tail`'s own: `-n +1` is the whole file, `-n N` its
 * last N lines (a negative N clamped to none), `-F` follows it across the
 * server's rotations.
 *
 * `tail`'s stderr is held back and printed only on a failure: in follow
 * mode it narrates retries nobody asked for, and when the exec itself fails
 * kubectl's message is the whole diagnosis.
 */
export async function clusterServerLogs(opts: { follow?: boolean; lines?: number } = {}): Promise<void> {
  const pods = (await kubectlGetJson<{ items?: RawServerPod[] }>([
    'get', 'pods', '-n', k8sNamespace(), '-l', `app=${SERVER_APP_NAME}`,
  ]))?.items ?? []
  const running = pods.find((p) => p.status?.containerStatuses
    ?.some((c) => c.name === 'server' && c.state?.running))?.metadata?.name
  if (running) {
    await tailServerLog(running, 'server', opts)
    return
  }
  await deleteLogReader(true)
  await kubectlApply(await buildLogReaderManifest(pods.find((p) => p.spec?.nodeName)?.spec?.nodeName))
  try {
    // Ready before the exec: `kubectl exec` waits for a pod it picks out of
    // a workload, never for one it is handed by name, so an exec into a
    // reader still pulling or starting fails at once with "container not
    // found".
    await kubectlWithRetry([
      'wait', '--for=condition=Ready', `pod/${LOG_READER_POD_NAME}`, '-n', k8sNamespace(),
      `--timeout=${String(LOG_READER_START_S)}s`,
    ], { timeout: (LOG_READER_START_S + 10) * 1000, maxAttempts: 1 }).catch((err: unknown) => {
      throw new Error(
        `the log reader pod did not become Ready within ${String(LOG_READER_START_S)}s `
        + `(${err instanceof Error ? err.message : String(err)}). Inspect it with `
        + `\`kubectl -n ${k8sNamespace()} describe pod ${LOG_READER_POD_NAME}\`.`,
      )
    })
    await tailServerLog(LOG_READER_POD_NAME, 'reader', opts)
  } finally {
    await deleteLogReader().catch(() => { /* bounded by its own deadline */ })
  }
}

interface RawServerPod {
  metadata?: { name?: string }
  spec?: { nodeName?: string }
  status?: { containerStatuses?: Array<{ name?: string; state?: { running?: unknown } }> }
}

const LOG_READER_POD_NAME = 'yaac-server-log-reader'
/** Long enough for the reader to schedule, attach its volume and pull. */
const LOG_READER_START_S = 120

/**
 * Remove the log reader: after a read, before the next one (`wait`), and
 * before a start or restart — a reader holding an attach-once claim on one
 * node would otherwise keep a server scheduled onto another stuck
 * `ContainerCreating` for as long as a `logs -f` runs, or its deadline.
 */
async function deleteLogReader(wait = false): Promise<void> {
  await kubectlWithRetry([
    'delete', 'pod', LOG_READER_POD_NAME, '-n', k8sNamespace(), '--ignore-not-found', `--wait=${String(wait)}`,
  ])
}
/** A reader outlives a CLI killed hard by at most this long. */
const LOG_READER_DEADLINE_S = 3600

/**
 * The reader: the server's own image and identity (both read off the
 * Deployment), the server-local claim read-only at the server's own path,
 * and nothing to do but wait to be exec'd into.
 */
async function buildLogReaderManifest(nodeName: string | undefined): Promise<Record<string, unknown>> {
  const dep = await kubectlGetJson<RawServerDeployment>([
    'get', 'deployment', SERVER_APP_NAME, '-n', k8sNamespace(),
  ])
  const podSpec = dep?.spec?.template?.spec
  const image = podSpec?.containers?.find((c) => c.name === 'server')?.image
  if (!image) throw new Error(`the ${SERVER_APP_NAME} Deployment names no server image to read the log with`)
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: LOG_READER_POD_NAME, namespace: k8sNamespace(), labels: { app: LOG_READER_POD_NAME } },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: LOG_READER_DEADLINE_S,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(nodeName ? { nodeName } : {}),
      securityContext: podSpec?.securityContext ?? {},
      containers: [{
        name: 'reader',
        image,
        imagePullPolicy: 'IfNotPresent',
        command: ['sleep', String(LOG_READER_DEADLINE_S)],
        securityContext: { allowPrivilegeEscalation: false },
        volumeMounts: [{ name: 'server-local', mountPath: POD_SERVER_LOCAL_ROOT, readOnly: true }],
      }],
      volumes: [{
        name: 'server-local',
        persistentVolumeClaim: { claimName: SERVER_LOCAL_CLAIM_NAME, readOnly: true },
      }],
    },
  }
}

async function tailServerLog(
  pod: string,
  container: string,
  opts: { follow?: boolean; lines?: number },
): Promise<void> {
  const logFile = path.posix.join(POD_SERVER_LOCAL_ROOT, path.basename(serverLogPath()))
  const args = [
    'exec', pod, '-n', k8sNamespace(), '-c', container, '--',
    'tail', ...(opts.follow ? ['-F'] : []),
    '-n', opts.lines !== undefined ? String(Math.max(0, opts.lines)) : '+1',
    logFile,
  ]
  const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(process.stdout, { end: false })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  await new Promise<void>((resolve, reject) => {
    // Forward Ctrl-C so the exec dies with us instead of being orphaned.
    const onSigint = (): void => { child.kill('SIGINT') }
    process.on('SIGINT', onSigint)
    child.on('error', (err) => {
      process.off('SIGINT', onSigint)
      reject(err)
    })
    child.on('close', (code, signal) => {
      process.off('SIGINT', onSigint)
      if (code === 0 || signal === 'SIGINT') {
        resolve()
        return
      }
      reject(new Error(
        `could not read the server log in pod ${pod}: `
        + `${stderr.trim() || `kubectl exited with ${signal ?? `code ${String(code)}`}`}`,
      ))
    })
  })
}
