/**
 * The yaac server, as a workload of the cluster it manages.
 *
 * Under this driver the server is not a process beside the cluster but a
 * single-replica Deployment inside it (docs/server-in-cluster.md), which is
 * what lets server and worktree pods eventually share one claim instead of
 * one host filesystem. Everything that puts it there lives here: its image,
 * its RBAC, its Deployment, the ingress policies that are the only thing
 * between an untrusted worktree pod and an unauthenticated API, and the
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
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  GLOBAL_CLAIM_NAME,
  LABEL_DATA_DIR_HASH,
  LABEL_INSTALL_NAMESPACE,
  POD_GLOBAL_ROOT,
  POD_NODE_LOCAL_ROOT,
  POD_SERVER_LOCAL_ROOT,
  PRIORITY_CLASS_INFRA,
  RELAY_PORT,
  SERVER_APP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  SERVER_POD_PORT,
  hostUidSecurityContext,
  SERVER_SA_NAME,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  nodeLocalNodePath,
  proxyServiceHost,
} from '#drivers/k8s/substrate'
import { ensureStorageClaims } from './storage'
import {
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  nodeIpBlocks,
} from '#drivers/k8s/cluster'
import { frontingOfService, type RemoteHosting, type ServerFronting } from './server-fronting'
import {
  contextHash,
  ensureImageByTag,
  stringHash,
} from '#drivers/k8s/image-engine'
import { pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
// The install root itself, not a place to put bytes: the pod is handed it
// as `YAAC_DATA_DIR` so its identity (`dataDirHash()`, every label, the
// cookie name) is the host's; what it MOUNTS are the three tier roots.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { getDataDir, globalRoot, nodeLocalRoot, serverLocalRoot } from '@yaac/shared/paths'
import { readLock } from '@yaac/shared/lock'
import { migrateDataDirLayout } from '@yaac/shared/data-dir-layout'
import {
  SERVER_LOCK_FILENAME,
  isLockLive,
  isSameHostLock,
  parseServerLock,
  type ServerLock,
} from '@yaac/shared/server-lock-file'
import { mintLocalClientToken, registerServer } from '@yaac/shared/server-config'
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
 * the yaac control plane — it creates worktree Jobs, applies the datapath,
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
        // and Role on start; the cluster-scoped pair because the legacy
        // vcluster sweep deletes objects an older install left behind
        // (docs/legacy-compat-shims.md), and a denied LIST there is a
        // sweep that silently never runs.
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
   * published — the tailnet name it admits, and whether a TLS-terminating
   * proxy stands in front. Unioned with what the install shell already
   * carries, never replacing it.
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
 * that they arrive from whatever environment ran `yaac cluster install` —
 * which is why the credential-affecting ones are called out in the install
 * log rather than absorbed silently.
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
    ['YAAC_TRUST_PROXY', hosting.trustProxy ? '1' : undefined],
    ['YAAC_REQUIRE_AUTH', env.requireAuth ? '1' : undefined],
    // The address the snapshot claims a worktree's forwarded ports answer
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
function effectiveRemoteHosting(fromFronting: RemoteHosting = { allowedHosts: [], trustProxy: false }): RemoteHosting {
  return {
    allowedHosts: [...new Set([...fromFronting.allowedHosts, ...env.allowedHosts])],
    trustProxy: fromFronting.trustProxy || env.trustProxy,
  }
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
 * priority, because a preempted server takes every worktree's control plane
 * with it.
 */
export function buildServerDeploymentManifest(
  imageRef: string,
  envOpts: ServerEnvOptions = {},
): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: SERVER_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: SERVER_APP_NAME },
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
          // The identity every path the server pre-creates for a worktree
          // pod is owned by, stamped from the installing host: on kind the
          // claims are hostPaths this machine owns and no pod can write
          // them as anything else. No `fsGroup`: the kubelet never manages
          // a hostPath's ownership, and HOME is the image's own rootfs,
          // writable through group 0.
          securityContext: hostUidSecurityContext(),
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
              // empty password and `su` over the data-dir hostPath. Worktree
              // pods are the opposite case by design: in-pod root is a
              // feature there and the gVisor sentry is the boundary.
              securityContext: { allowPrivilegeEscalation: false },
              ports: [{ containerPort: SERVER_POD_PORT }],
              env: buildServerEnv(envOpts),
              readinessProbe: {
                httpGet: {
                  path: '/health',
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
              // every worktree's reconcile at once.
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
          // every worktree pod on the node mounts its caches under.
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
 * pods is a window in which a worktree could use it; and the Service is
 * applied before the Deployment, because the origin the fronting publishes
 * (read off the Service on a tailnet) is an input to the Deployment's
 * environment. On an existing kind install the Service apply is also what
 * releases the old NodePort on the node before the forwarder binds it.
 *
 * Returns the published origin.
 */
export async function ensureServerDeployment(
  imageRef: string,
  fronting: ServerFronting,
  envOpts: ServerEnvOptions = {},
): Promise<string> {
  await kubectlApply(buildServerServiceAccountManifest())
  await kubectlApply(buildServerClusterRoleManifest())
  await kubectlApply(buildServerClusterRoleBindingManifest())
  await kubectlApply(buildServerIngressNpManifest(await nodeIpBlocks()))
  await kubectlApply(buildServerFrontIngressNpManifest(fronting.ingressPeers()))
  await kubectlApply(fronting.serviceManifest())
  const origin = await fronting.resolveOrigin()
  await kubectlApply(buildServerDeploymentManifest(imageRef, {
    ...envOpts,
    remoteHosting: fronting.remoteHosting(origin),
  }))
  const extras = fronting.extraManifests()
  for (const manifest of extras) await kubectlApply(manifest)
  for (const manifest of extras) {
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

/** Whether the cluster carries a server Deployment at all. */
export async function serverDeploymentExists(): Promise<boolean> {
  const dep = await kubectlGetJson<{ metadata?: { name?: string } }>([
    'get', 'deployment', SERVER_APP_NAME, '-n', k8sNamespace(),
  ])
  return dep !== null
}

/**
 * Whether the server this install deploys will skip the credential gate —
 * the same question `isCredentialOptional` asks server-side, asked here
 * because install is where the environment that decides it is read.
 * Deliberately not an import: `#api/http` sits above the driver.
 */
function isLoopbackOnlyInstall(remoteHosting: RemoteHosting): boolean {
  const hosting = effectiveRemoteHosting(remoteHosting)
  return hosting.allowedHosts.length === 0 && !hosting.trustProxy && !env.requireAuth
}

/**
 * Point every client on this machine at the published origin, and record
 * that this install runs its server in the cluster.
 *
 * One call, because the two facts are one fact: the file that says where
 * the server is also says what kind of install put it there, so a client
 * that cannot reach it knows to converge rather than to spawn. The
 * registration itself is `@yaac/shared`'s and is shared with `yaac server
 * start` — an install is not special, it just happens to stand up a
 * Deployment instead of a process (docs/server-in-cluster.md).
 */
export async function writeServerRemote(
  origin: string,
  credentialRequired: boolean,
  log: (message: string) => void = () => { /* quiet by default */ },
): Promise<void> {
  await registerServer(origin, 'k8s', {
    log,
    // An empty token is right on the loopback install, where nothing
    // checks it. On a credential-REQUIRING one it is a lockout, and the
    // note printed before this promised it would not happen.
    credentialRequired,
    mint: (o) => mintLocalClientToken(o, readPodLock),
  })
}

/**
 * The lock the POD holds, read by asking the pod.
 *
 * The mint authenticates with the lock's per-boot secret, and the lock is
 * the server's file: on kind the host could still open it through the
 * hostPath, on a cloud cluster the data dir is not on this machine at all.
 * One path for both, so a fronting that puts the server out of the host's
 * reach needs no second mint. The path is the pod's own server-local root,
 * from the environment the Deployment states.
 */
async function readPodLock(): Promise<ServerLock | null> {
  try {
    const { stdout } = await kubectlWithRetry([
      'exec', '-n', k8sNamespace(), `deployment/${SERVER_APP_NAME}`, '--',
      'sh', '-c', `cat "\${YAAC_SERVER_LOCAL_ROOT:-$YAAC_DATA_DIR}/${SERVER_LOCK_FILENAME}"`,
    ], { timeout: 30_000, maxAttempts: 3 })
    return parseServerLock(stdout)
  } catch {
    return null
  }
}

/**
 * Stop the server that is there, bring the data dir into the tier
 * layout, build the image, apply the workload, wait for the published
 * origin to answer, and point this machine's clients at it — the whole of
 * "the server now runs in the cluster", as one step `yaac cluster install`
 * injects and unit tests replace.
 *
 * The stop comes FIRST, before the layout migration, and that order is
 * the point: an old pod holds PGlite open by path and heartbeats its lock
 * by path, and renaming `db/` under a running server is a stranded or
 * corrupt database. `stopClusterServer` waits on the pod's deletion, so
 * once it returns the data dir is quiescent. Install rolls the server
 * anyway (`Recreate`); stopping it earlier moves the outage ahead of the
 * image build rather than adding one.
 *
 * Returns the origin it published, which is what install prints.
 */
export async function deployServerWorkload(
  opts: ServerEnvOptions & { fronting: ServerFronting; log: (message: string) => void },
): Promise<string> {
  await refuseIfHostServerRunning()
  if (await serverDeploymentExists()) {
    opts.log('Stopping the running server pod...')
    await stopClusterServer()
  }
  await migrateDataDirLayout(opts.log)
  await ensureStorageClaims({
    globalHostPath: globalRoot(),
    serverLocalHostPath: serverLocalRoot(),
    nodeLocalHostPath: nodeLocalRoot(),
    log: opts.log,
  })
  opts.log('Building the server image (from the bundle)...')
  const imageRef = await ensureServerImage()
  opts.log(`Deploying the yaac server (${imageRef})...`)
  // Pass the options straight through rather than re-listing the fields:
  // every `ServerEnvOptions` member is optional, so a hand-copied list lets
  // the next field added go missing from the Deployment with no compile error.
  const origin = await ensureServerDeployment(imageRef, opts.fronting, opts)
  await waitForPublishedServer(origin, opts.fronting.unreachableDiagnosis(origin))
  const credentialRequired = !isLoopbackOnlyInstall(opts.fronting.remoteHosting(origin))
  if (credentialRequired) {
    // Worth saying out loud, because it is the one setting here that can
    // arrive by accident: these are read from the environment `yaac cluster
    // install` runs in, and a shell that already has them (a machine
    // hosting another yaac remotely) hands them to a brand-new install that
    // did not ask for them.
    opts.log(
      'note: this server will REQUIRE a credential — it is published beyond '
      + 'this machine\'s loopback, or YAAC_ALLOWED_HOSTS / YAAC_TRUST_PROXY is '
      + 'set in this environment and the Deployment carries it. server.json '
      + 'below gets a durable token so the CLI on this machine keeps working '
      + '— and this install says so plainly if that mint fails. Unset them '
      + 'and re-install if it was not intended (docs/remote-hosting.md).',
    )
  }
  // Also records that this data dir IS a k8s install, so a later `yaac
  // server start` from an ordinary shell finds the Deployment instead of
  // spawning a second server beside it.
  await writeServerRemote(origin, credentialRequired, opts.log)
  return origin
}

/**
 * Refuse to deploy the pod while a HOST server still holds this data dir.
 *
 * The documented upgrade is `npm update`, then install — run, ordinarily,
 * on an install whose server is up. Deploying into that leaves two writers
 * on one directory, and neither of the mechanisms that normally prevent
 * that catches it:
 *
 *  - A pre-lease lock (written by a server predating the in-cluster work)
 *    carries no `host`, which `isSameHostLock` reads as "this host". True
 *    for every host-side reader, and wrong inside the POD — which then
 *    judges by `pidExists` in its own pid namespace, finds the host pid
 *    absent, calls the lock stale, unlinks it and opens PGlite underneath
 *    a server that is still running.
 *  - `waitForPublishedServer` probes the loopback origin, and on a cluster
 *    predating the port mapping that is answered by the OLD HOST SERVER.
 *    Install then reports success and mints a token against it, writing a
 *    `server.json` that points every client at the process it was meant to
 *    replace — a green banner over a permanent dual-writer.
 *
 * The check belongs here because here is where it still works: install
 * runs on the host, where a legacy lock's pid and `/health` both answer
 * about the right process. One refusal, before anything is applied.
 */
async function refuseIfHostServerRunning(): Promise<void> {
  const lock = await readLock()
  // `isSameHostLock`, not "has no host field": a server predating the lease
  // writes no `host` and a current one writes this machine's, and BOTH are
  // host processes holding this data dir. Keying on the field's absence
  // would catch only the older of the two and wave the commoner case
  // through — which is how this guard was first written, and what running
  // it caught. An off-host lock is skipped because it is this install's own
  // pod: rolling that IS what install does, sequenced by `Recreate`.
  if (!lock || !isSameHostLock(lock) || !await isLockLive(lock)) return
  throw new Error(
    'a yaac server is already running on this data dir as a host process '
    + `(pid ${String(lock.pid)}, port ${String(lock.port)}).\n`
    + '    Deploying the server into the cluster now would put two servers on '
    + 'one database.\n'
    + '    Stop it first: `yaac server stop`, then re-run `yaac cluster install`.',
  )
}

/** How long to wait for the published origin to answer after a roll. */
const PUBLISH_PROBE_TIMEOUT_MS = 60_000

/**
 * Wait for the ROLLED server to answer at its published origin, and turn
 * "it never does" into the fronting's own diagnosis of why.
 *
 * A Deployment that is Available while the origin refuses is not a server
 * problem: on kind it is a cluster created before the port mapping existed
 * (which cannot be converged, only recreated), on a tailnet it is this
 * machine not being able to reach the name the operator published. The
 * fronting knows which, so it supplies the text.
 */
async function waitForPublishedServer(
  origin: string,
  diagnosis: string,
  timeoutMs = PUBLISH_PROBE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const body = await res.json() as { ready?: unknown }
        if (body.ready === true) return
        last = 'answered /health but is still initializing'
      } else last = `answered HTTP ${String(res.status)}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `the server Deployment rolled out, but ${origin} does not answer (${last}).\n`
    + `    ${diagnosis}`,
  )
}

/**
 * The fronting this install's live Service records, which is what the
 * start and restart verbs wait on. Read fresh each time: nothing on disk
 * says which fronting was installed, and the Service is the one object
 * that does.
 */
async function installedFronting(): Promise<ServerFronting> {
  const svc = await kubectlGetJson<Record<string, unknown>>([
    'get', 'service', SERVER_APP_NAME, '-n', k8sNamespace(),
  ])
  return frontingOfService(svc)
}

/** Wait for the installed fronting's origin to answer, and return it. */
async function waitForInstalledServer(): Promise<string> {
  const fronting = await installedFronting()
  const origin = await fronting.resolveOrigin()
  await waitForPublishedServer(origin, fronting.unreachableDiagnosis(origin))
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
  await kubectlWithRetry([
    'rollout', 'restart', `deployment/${SERVER_APP_NAME}`, '-n', k8sNamespace(),
  ], { timeout: 60_000 })
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
    '-n', k8sNamespace(), '--timeout=300s',
  ], { timeout: 310_000, maxAttempts: 2 })
  return waitForInstalledServer()
}
