/**
 * Deploys the yaac server as a single-replica Deployment in the cluster it
 * manages (docs/server-in-cluster.md): its image, RBAC, Deployment, the
 * ingress policies that keep workspace pods off its API, and the
 * `server.json` that points clients at its origin. How the Service is
 * reached from outside is a `ServerFronting` (server-fronting.ts).
 *
 * Only the CLI applies the Deployment; a server that rolled itself could
 * get stuck in a state it cannot roll back from.
 *
 * The pod mounts the three storage tiers (storage.ts) at fixed pod paths.
 * `YAAC_DATA_DIR` still names the host's data dir, so `dataDirHash()` and
 * every label match the host's.
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
  SERVER_APP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  SERVER_POD_PORT,
  SERVER_SA_NAME,
  dataDirHash,
  applyObject,
  deleteObject,
  k8sNamespace,
  listObjects,
  patchObject,
  readObject,
  waitForRollout,
  installSecurityContext,
  nodeLocalNodePath,
  processIdentity,
  type InstallIdentity,
  type ObjectRef,
} from '#drivers/k8s/substrate'
import { waitFor } from '#lib/wait-for'
import { ensureStorageClaims, type StorageShape } from './storage'
import {
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  nodeIpBlocks,
} from '#drivers/k8s/cluster'
import { liveFronting, type RemoteHosting, type ServerFronting } from './server-fronting'
import {
  contextHash,
  ensureImageByTag,
  stringHash,
} from '#drivers/k8s/image-engine'
import { pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
// The data dir is passed to the pod as an identity, not for storage.
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
 * Build context of the server image: the built bundle (`dist/`), not the
 * source tree. In an npm install `PACKAGE_ROOT` is the bundle; in a source
 * checkout it is `dist/` under the repo root, produced by `pnpm build`.
 */
function serverImageContext(): string {
  return env.bundled ? PACKAGE_ROOT : path.join(PACKAGE_ROOT, 'dist')
}

function serverDockerfile(context = serverImageContext()): string {
  return path.join(context, 'dockerfiles', 'Dockerfile.server')
}

/**
 * The server image's tag: a content hash of the bundle. A changed bundle
 * gets a new tag, which rolls the Deployment. The image works for any uid
 * (docs/arbitrary-uid-images.md), so the uid is not part of the tag.
 */
export async function resolveServerImageTag(
  context = serverImageContext(),
  prefix = testEnv.imagePrefix ?? 'yaac',
): Promise<string> {
  return `${prefix}-server:${stringHash(await contextHash(context))}`
}

/**
 * Build the server image if the registry lacks it, and push it. The e2e
 * tiers pass a frozen copy of the bundle (`dist-test/`) and their own
 * prefix, so a `pnpm watch` rebuild mid-run cannot change the tag.
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

/** Server pod labels, including the install identity. */
function serverPodLabels(): Record<string, string> {
  return { app: SERVER_APP_NAME, [LABEL_DATA_DIR_HASH]: dataDirHash() }
}

/**
 * ServiceAccount the server acts as: it creates workspace Jobs, applies
 * the datapath, and creates per-project registry namespaces.
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
 * Name of the server's ClusterRole and ClusterRoleBinding, suffixed with
 * the namespace since several installs (e.g. e2e runs) share a cluster.
 */
function serverClusterScopedName(): string {
  return `${SERVER_SA_NAME}-${k8sNamespace()}`
}

/**
 * Labels on the server's cluster-scoped RBAC. These are not deleted with
 * the namespace, so the install namespace label lets the e2e sweep find an
 * interrupted run's leftovers.
 */
function serverClusterScopedLabels(): Record<string, string> {
  return { app: SERVER_APP_NAME, [LABEL_INSTALL_NAMESPACE]: k8sNamespace() }
}

/**
 * The server's permissions. Cluster-scoped because per-project registries
 * live in namespaces the server creates at runtime, and because it applies
 * the cluster-scoped builder-role admission guard. Full access to what it
 * owns, read-only on what it only observes.
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
        // The server applies the proxy's and netd's Roles on start, and
        // deletes netd's legacy cluster RBAC (docs/legacy-compat-shims.md).
        // RBAC's escalation check still limits what it can grant.
        apiGroups: ['rbac.authorization.k8s.io'],
        resources: ['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'],
        verbs: ['*'],
      },
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

interface ServerEnvOptions {
  /**
   * The host's address on the kind network, when `YAAC_USE_TOR` is set.
   * Absent leaves the configured Tor URL unchanged.
   */
  torHostAddr?: string
  /** The access mode and allowed hosts the fronting requires. */
  remoteHosting?: RemoteHosting
  /** `--owner`: the tailnet login that claims a `local` install's data when
   *  it switches to `tailnet` (docs/remote-hosting.md "Access modes"). */
  owner?: string
}

/**
 * The server pod's environment. `YAAC_DATA_DIR` is the host's path, so the
 * install's identity is unchanged; the three root variables are where the
 * storage tiers are mounted (docs/server-in-cluster.md "Storage
 * claims"). `YAAC_IN_CLUSTER` makes the registry client dial the
 * registry's Service directly.
 *
 * Pass-through settings are copied from the environment that ran
 * `yaac cluster install`, since a pod has no shell to set them in later.
 */
function buildServerEnv(opts: ServerEnvOptions = {}): Array<{ name: string; value: string }> {
  const hosting = opts.remoteHosting ?? { accessMode: 'local', allowedHosts: [] }
  const vars: Array<{ name: string; value: string }> = [
    { name: 'YAAC_IN_CLUSTER', value: '1' },
    // The ingress NetworkPolicy restricts access instead of a loopback bind.
    { name: 'YAAC_BIND_ADDR', value: '0.0.0.0' },
    { name: 'YAAC_SERVER_PORT', value: String(SERVER_POD_PORT) },
    { name: 'YAAC_DATA_DIR', value: getDataDir() },
    { name: 'YAAC_GLOBAL_ROOT', value: POD_GLOBAL_ROOT },
    { name: 'YAAC_SERVER_LOCAL_ROOT', value: POD_SERVER_LOCAL_ROOT },
    { name: 'YAAC_NODE_LOCAL_ROOT', value: POD_NODE_LOCAL_ROOT },
    { name: 'YAAC_DRIVER', value: 'k8s' },
  ]
  const passThrough: Array<[string, string | undefined]> = [
    ['YAAC_K8S_NAMESPACE', testEnv.k8sNamespace],
    ['YAAC_IMAGE_PREFIX', testEnv.imagePrefix],
    // The access mode the server checks against the one it recorded.
    ['YAAC_ACCESS_MODE', hosting.accessMode],
    ['YAAC_ACCESS_OWNER', opts.owner],
    ['YAAC_ALLOWED_HOSTS', hosting.allowedHosts.join(',')],
    // Display address for forwarded ports; a remote-hosting install sets
    // it (e.g. a tailnet IP matching `yaac forward --bind`).
    ['YAAC_FORWARD_BIND', env.forwardBind === '127.0.0.1' ? undefined : env.forwardBind],
    ['YAAC_USE_TOR', env.useTor ? '1' : undefined],
    ['YAAC_HOST_TOR_SOCKS_URL', env.useTor ? torSocksUrlForPod(opts.torHostAddr) : undefined],
    // Datapath settings the server applies on every start.
    ['YAAC_CNI_VETH_PREFIX', env.cniVethPrefix],
    ['YAAC_POD_CIDRS', env.podCidrs.length > 0 ? env.podCidrs.join(',') : undefined],
    ['YAAC_KUBE_PROXY_EXTERNAL', env.kubeProxyExternal ? '1' : undefined],
    ['YAAC_E2E_SKIP_FETCH', testEnv.e2eSkipFetch ? '1' : undefined],
    // Encryption keys for stored secrets, when the operator sets them.
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
 * The host's Tor SOCKS URL as seen from a pod: a loopback host is replaced
 * with the host's address on the kind network. Tor must listen on that
 * interface, which install warns about; otherwise git fetches hang.
 */
function torSocksUrlForPod(hostAddr?: string): string {
  const raw = env.torSocksUrl
  if (hostAddr === undefined) return raw
  try {
    const url = new URL(raw)
    // The URL parser keeps the brackets on an IPv6 host.
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
 * The server Deployment. One replica with `Recreate`, since PGlite allows a
 * single writer (on kind the lock's lease enforces it, as a hostPath claim
 * has no attach exclusivity). Runs on runc, since it is yaac's own code,
 * at infra priority.
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
          // The install's uid/gid, read back by deployedInstallIdentity.
          // No `fsGroup`: install already chowned the claim roots.
          securityContext: installSecurityContext(identity),
          terminationGracePeriodSeconds: 30,
          containers: [
            {
              name: 'server',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              // Blocks setuid: with a group-writable /etc/passwd, setuid
              // `su` would otherwise allow becoming root on runc. Workspace
              // pods don't get this: root inside them is a feature (sudo),
              // and gVisor is their boundary.
              securityContext: { allowPrivilegeEscalation: false },
              ports: [{ containerPort: SERVER_POD_PORT }],
              env: buildServerEnv(envOpts),
              readinessProbe: {
                httpGet: {
                  path: '/api/health',
                  port: SERVER_POD_PORT,
                  // The server's DNS-rebind guard would reject the pod
                  // IP as Host.
                  httpHeaders: [{ name: 'Host', value: '127.0.0.1' }],
                },
                periodSeconds: 2,
                failureThreshold: 60,
              },
              // No CPU limit: throttling the server would slow every
              // workspace's reconcile.
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
          // The three storage tiers (storage.ts).
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
 * Apply the server workload and its fronting, wait for both to roll out,
 * and return the published origin. Order matters: RBAC before the pod;
 * ingress policies before the Service, so workspaces never see an open
 * API; and the fronting before the Deployment, whose env needs the origin.
 */
async function ensureServerDeployment(
  imageRef: string,
  fronting: ServerFronting,
  identity: InstallIdentity,
  envOpts: ServerEnvOptions & { installId?: string } = {},
): Promise<string> {
  await applyObject(buildServerServiceAccountManifest())
  await applyObject(buildServerClusterRoleManifest())
  await applyObject(buildServerClusterRoleBindingManifest())
  await applyObject(buildServerIngressNpManifest(await nodeIpBlocks()))
  await applyObject(buildServerFrontIngressNpManifest(fronting.ingressPeers()))
  // Wait, so `installedFronting` never reads a retired Ingress that is
  // still terminating behind the tailnet operator's finalizer.
  for (const retired of fronting.retired()) {
    await deleteObject({ ...retired, namespace: k8sNamespace() }, { wait: true, timeoutMs: 60_000 })
  }
  const manifests = fronting.manifests()
  for (const manifest of manifests) await applyObject(manifest)
  const origin = await fronting.resolveOrigin()
  await applyObject(buildServerDeploymentManifest(imageRef, identity, {
    ...envOpts,
    remoteHosting: fronting.remoteHosting(origin),
  }))
  for (const manifest of manifests) {
    if (manifest.kind !== 'Deployment') continue
    await waitForDeployment((manifest.metadata as { name: string }).name, 120)
  }
  await waitForDeployment(SERVER_APP_NAME)
  return origin
}

/** Wait for a Deployment in this install's namespace to roll out. */
function waitForDeployment(name: string, timeoutSeconds = 300): Promise<void> {
  return waitForRollout({
    workload: `deployment/${name}`, namespace: k8sNamespace(), timeoutMs: timeoutSeconds * 1000,
  })
}

function serverDeploymentRef(): ObjectRef {
  return { apiVersion: 'apps/v1', kind: 'Deployment', name: SERVER_APP_NAME, namespace: k8sNamespace() }
}

/** Set the Deployment's replica count; the caller waits for it to settle. */
async function scaleServerDeployment(replicas: number): Promise<void> {
  await patchObject(serverDeploymentRef(), { spec: { replicas } })
}

interface RawServerDeployment {
  spec?: {
    template?: {
      spec?: {
        securityContext?: { runAsUser?: unknown; runAsGroup?: unknown }
        containers?: Array<{ name?: string; image?: string; env?: Array<{ name?: string; value?: string }> }>
      }
    }
  }
}

/**
 * The uid and gid a byo install's pods run as. Fixed rather than the
 * installing machine's uid, so NFS ownership stays stable whichever machine
 * re-installs (docs/server-in-cluster.md "The uid everything runs as").
 */
export const BYO_INSTALL_IDENTITY: InstallIdentity = { uid: 1000, gid: 1000 }

/**
 * The uid/gid this install's pods run as, read from the live server
 * Deployment. Used by `cluster check`'s probe pods and the e2e harness.
 * With no Deployment, falls back to what install would deploy: the byo
 * constant, or this machine's uid on kind. A failed read throws.
 */
export async function deployedInstallIdentity(byo: boolean): Promise<InstallIdentity> {
  const dep = await readObject<RawServerDeployment>(serverDeploymentRef())
  const sc = dep?.spec?.template?.spec?.securityContext
  if (typeof sc?.runAsUser === 'number' && typeof sc.runAsGroup === 'number') {
    return { uid: sc.runAsUser, gid: sc.runAsGroup }
  }
  return byo ? BYO_INSTALL_IDENTITY : processIdentity()
}

/** Whether the cluster carries a server Deployment at all. */
export async function serverDeploymentExists(): Promise<boolean> {
  return await readObject(serverDeploymentRef()) !== null
}

/**
 * Stop any running server pod, build the image, set up storage, apply the
 * workload, wait for the origin to answer, and register it in
 * `server.json`. Returns the origin.
 */
export async function deployServerWorkload(
  opts: ServerEnvOptions & {
    fronting: ServerFronting
    /** The uid and gid install decided this install's pods run as. */
    identity: InstallIdentity
    /** Who this install is (`server.json`'s `installId`). */
    installId: string
    /** Static volumes (kind) or storage classes (byo) for the claims. */
    storage: { kind: 'static' } | { kind: 'classes'; rwx: string; rwo: string }
    log: (message: string) => void
  },
): Promise<string> {
  await refuseIfHostServerRunning()
  if (await serverDeploymentExists()) {
    opts.log('Stopping the running server pod...')
    await stopClusterServer()
  }
  // Build the image first: the storage binder pod runs it.
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
  // Pass opts whole: every `ServerEnvOptions` field is optional, so a
  // copied field list could silently drop a new one.
  const origin = await ensureServerDeployment(imageRef, opts.fronting, opts.identity, opts)
  await waitForPublishedServer(origin, opts.fronting)
  // Point this machine's clients at the origin and record the data dir as
  // k8s, so `yaac server start` manages the Deployment rather than
  // spawning a host server (docs/server-in-cluster.md).
  await registerServer(origin, 'k8s')
  // Without a loopback path this CLI must pass the identity check too;
  // warn now if it cannot.
  await probeServer(origin).catch((err: unknown) => {
    if (err instanceof IdentityRejectedError) {
      opts.log(`WARNING: ${err.message}\n    The CLI on this machine cannot use this server `
        + 'until it runs as a tailnet user (docs/remote-hosting.md).')
    }
  })
  return origin
}

/**
 * Refuse to deploy while a host server holds this data dir: that would be
 * two writers on one database, and the host server could even answer the
 * origin probe, making install look successful.
 */
async function refuseIfHostServerRunning(): Promise<void> {
  const lock = await readLock()
  // An off-host lock is this install's own pod, which install rolls.
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
 * Wait for the rolled-out server to report ready at its origin. On timeout,
 * an unreachable origin gets the fronting's diagnosis.
 */
async function waitForPublishedServer(origin: string, fronting: ServerFronting): Promise<void> {
  const deadline = Date.now() + fronting.publishTimeoutMs
  let last = 'no attempt made'
  let reached = false
  while (Date.now() < deadline) {
    let refused: unknown
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })
      reached = true
      if (res.ok) {
        const body = await res.json() as { ready?: unknown; refused?: unknown }
        if (body.ready === true) return
        refused = body.refused
        last = 'answered /api/health but is still initializing'
      } else last = `answered HTTP ${String(res.status)}`
    } catch (err) {
      reached = false
      last = err instanceof Error ? err.message : String(err)
    }
    // The server refused to start in this access mode; the reason names the fix.
    if (typeof refused === 'string') throw new Error(`the server refused to start: ${refused}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(reached
    ? `the server Deployment rolled out and ${origin} answers, but not as a ready server (${last}).`
    : `the server Deployment rolled out, but ${origin} does not answer (${last}).\n`
      + `    ${fronting.unreachableDiagnosis(origin)}`)
}

/** The installed fronting, read from the live cluster (see liveFronting). */
async function installedFronting(): Promise<ServerFronting> {
  const ingress = await readObject<Record<string, unknown>>({
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', name: SERVER_APP_NAME, namespace: k8sNamespace(),
  })
  const dep = await readObject<RawServerDeployment>(serverDeploymentRef())
  return liveFronting(ingress, dep?.spec?.template?.spec?.containers?.find((c) => c.name === 'server')?.env ?? [])
}

/** Wait for the installed fronting's origin to answer, and return it. */
async function waitForInstalledServer(): Promise<string> {
  const fronting = await installedFronting()
  const origin = await fronting.resolveOrigin()
  await waitForPublishedServer(origin, fronting)
  return origin
}

/**
 * `yaac server start`: scale the existing Deployment back to one replica
 * and return the origin once it answers. It does not deploy anything.
 */
export async function startClusterServer(): Promise<string> {
  await deleteLogReader()
  await scaleServerDeployment(1)
  await waitForDeployment(SERVER_APP_NAME)
  return waitForInstalledServer()
}

/**
 * `yaac server stop`: scale to zero, keeping the Deployment so `start` can
 * bring it back without a full install.
 */
export async function stopClusterServer(): Promise<void> {
  await scaleServerDeployment(0)
  // Wait for the pod to go: a Deployment at zero replicas omits
  // `status.replicas`, so waiting on the count would always time out. A
  // slow drain, or a failed read while draining, is not a failed stop; a
  // successor waits on the lease.
  await waitFor(
    async () => (await serverPods().catch(() => null))?.length === 0,
    { timeoutMs: 60_000, intervalMs: 1_000 },
  )
}

/**
 * `yaac server restart`: roll the pod and return the origin once it
 * answers. `Recreate` removes the old pod before starting the new one.
 */
export async function restartClusterServer(): Promise<string> {
  await deleteLogReader()
  // What `kubectl rollout restart` does: a template change rolls the pod.
  await patchObject(serverDeploymentRef(), {
    spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } },
  })
  await waitForDeployment(SERVER_APP_NAME)
  return waitForInstalledServer()
}

/**
 * `yaac server logs` on a byo install, where the log is on a volume this
 * machine cannot see (kind's CLI reads the host file directly). Runs
 * `tail` in the server pod if it is running, otherwise in a short-lived
 * reader pod that mounts the claim read-only, on the server pod's node if
 * it has one. `tail`'s stderr is shown only on failure.
 */
export async function clusterServerLogs(opts: { follow?: boolean; lines?: number } = {}): Promise<void> {
  const pods = await serverPods()
  const running = pods.find((p) => p.status?.containerStatuses
    ?.some((c) => c.name === 'server' && c.state?.running))?.metadata?.name
  if (running) {
    await tailServerLog(running, 'server', opts)
    return
  }
  await deleteLogReader(true)
  await applyObject(await buildLogReaderManifest(pods.find((p) => p.spec?.nodeName)?.spec?.nodeName))
  try {
    // `kubectl exec` by pod name does not wait for the container to start.
    // A failed read counts as not Ready yet.
    const ready = await waitFor(async () => (await readObject<RawServerPod>(logReaderRef()).catch(() => null))
      ?.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
    { timeoutMs: LOG_READER_START_S * 1000, intervalMs: 1_000 })
    if (!ready) {
      throw new Error(
        `the log reader pod did not become Ready within ${String(LOG_READER_START_S)}s. Inspect it with `
        + `\`kubectl -n ${k8sNamespace()} describe pod ${LOG_READER_POD_NAME}\`.`,
      )
    }
    await tailServerLog(LOG_READER_POD_NAME, 'reader', opts)
  } finally {
    await deleteLogReader().catch(() => { /* bounded by its own deadline */ })
  }
}

interface RawServerPod {
  metadata?: { name?: string }
  spec?: { nodeName?: string }
  status?: {
    containerStatuses?: Array<{ name?: string; state?: { running?: unknown } }>
    conditions?: Array<{ type?: string; status?: string }>
  }
}

function serverPods(): Promise<RawServerPod[]> {
  return listObjects<RawServerPod>('v1', 'Pod', { namespace: k8sNamespace(), labelSelector: `app=${SERVER_APP_NAME}` })
}

const LOG_READER_POD_NAME = 'yaac-server-log-reader'
/** Long enough for the reader to schedule, attach its volume and pull. */
const LOG_READER_START_S = 120

/**
 * Remove the log reader after a read, before the next one, and before a
 * start or restart, since it can hold an attach-once claim the server
 * needs on another node.
 */
async function deleteLogReader(wait = false): Promise<void> {
  await deleteObject(logReaderRef(), { wait })
}

function logReaderRef(): ObjectRef {
  return { apiVersion: 'v1', kind: 'Pod', name: LOG_READER_POD_NAME, namespace: k8sNamespace() }
}
/** A reader outlives a CLI killed hard by at most this long. */
const LOG_READER_DEADLINE_S = 3600

/**
 * The log reader pod: the server's image and identity (from the
 * Deployment), with the server-local claim mounted read-only, sleeping
 * until exec'd into.
 */
async function buildLogReaderManifest(nodeName: string | undefined): Promise<Record<string, unknown>> {
  const dep = await readObject<RawServerDeployment>(serverDeploymentRef())
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
  // kubectl exec: a stream into the pod, and `-F` follows it until Ctrl-C.
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
