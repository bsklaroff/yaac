/**
 * The yaac server, as a workload of the cluster it manages.
 *
 * Under this driver the server is not a process beside the cluster but a
 * single-replica Deployment inside it (docs/server-in-cluster.md), which is
 * what lets server and worktree pods eventually share one claim instead of
 * one host filesystem. Everything that puts it there lives here: its image,
 * its RBAC, its Deployment and Service, the ingress policy that is the only
 * thing between an untrusted worktree pod and an unauthenticated API, and
 * the `server.json` that points every client at the published origin.
 *
 * Install-only, like the rest of this folder. The server never applies its
 * own Deployment — a workload that rolls itself is a workload that can roll
 * itself into a state it cannot roll back out of.
 *
 * Storage is deliberately unchanged here: the pod hostPath-mounts the real
 * data dir at the same absolute path the host process used, so
 * `dataDirHash()`, every existing hostPath mount and the worktree-pod view
 * of the world are byte-identical either side of the move. Turning those
 * into claims is phase 3 of the plan.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  LABEL_DATA_DIR_HASH,
  PRIORITY_CLASS_INFRA,
  RELAY_PORT,
  SERVER_APP_NAME,
  SERVER_NODE_PORT,
  SERVER_POD_PORT,
  hostUidSecurityContext,
  podUid,
  SERVER_SA_NAME,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  proxyServiceHost,
} from '#drivers/k8s/substrate'
import { buildServerIngressNpManifest, clusterPodCidrs } from '#drivers/k8s/cluster'
import {
  contextHash,
  ensureImageByTag,
  stringHash,
} from '#drivers/k8s/image-engine'
import { pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
// The install root itself, not a place to put bytes: what the pod mounts in
// phase 2 is the WHOLE data dir at its own absolute path, so that every tier
// resolves inside the pod exactly as it did on the host. Phase 3 is where
// the tiers become separate volumes and this becomes three mounts.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { getDataDir } from '@yaac/shared/paths'
import { readLock } from '@yaac/shared/lock'
import { isLockLive, isSameHostLock } from '@yaac/shared/server-lock-file'
import { registerServer } from '@yaac/shared/server-config'
import { resolveServerPort } from '@yaac/shared/server-port'
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
 * The server image's tag: the content hash of the bundle it contains, plus
 * the uid its `yaac` user is built with.
 *
 * Same contract as every other yaac-shipped image — an unchanged bundle
 * costs one registry HEAD, and a rebuilt one is a different image, which is
 * exactly the signal the Deployment rolls on.
 *
 * The uid is in the tag for the same reason it is in `baseImageHash`, and
 * it is a parameter for the same reason: an image built for one uid must
 * not answer a lookup for another. Hashing only the bundle would let a
 * host find a tag already in the registry whose `yaac` user is a number
 * that host's Deployment does not run as — a pod with no such user, whose
 * HOME belongs to someone else.
 */
export async function resolveServerImageTag(
  context = serverImageContext(),
  prefix = testEnv.imagePrefix ?? 'yaac',
  uid = podUid(),
): Promise<string> {
  return `${prefix}-server:${stringHash(`${await contextHash(context)}:uid=${String(uid)}`)}`
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
  // One read of the uid for both the tag and the build arg: the two
  // diverging is precisely the bug this tag exists to prevent.
  const uid = podUid()
  const tag = await resolveServerImageTag(context, prefix, uid)
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
  // The uid the SERVER POD runs as, which is what the image's own user has
  // to be. That uid is this machine's, because the install is what knows
  // it and the pod cannot: virtiofs makes the host user's uid a ceiling on
  // what any pod can write in the data dir (see `podUid`).
  await ensureImageByTag(tag, dockerfile, context, {
    YAAC_UID: String(uid),
  })
  return pushImageToRegistry(tag)
}

/**
 * The loopback origin the server is published at: the host end of the kind
 * `extraPortMapping` that fronts its NodePort. Fixed when the cluster is
 * CREATED, which is why a pre-install-era cluster cannot be converged into
 * publishing one — see `waitForPublishedServer`, which is where that turns
 * into a message.
 */
export function serverPublishedOrigin(): string {
  return `http://127.0.0.1:${resolveServerPort()}`
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
  return { app: SERVER_APP_NAME, 'yaac.install-namespace': k8sNamespace() }
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
}

/**
 * Environment the Deployment hands the server: what it can no longer read
 * off a host, plus the host-side shims it must not take.
 *
 * `YAAC_DATA_DIR` names the same absolute path the host process used —
 * hostPath-mounted below — so the install's identity (`dataDirHash()`,
 * every pod label, the DB) carries over unchanged. `YAAC_RELAY_ADDR` points
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
  const vars: Array<{ name: string; value: string }> = [
    { name: 'YAAC_IN_CLUSTER', value: '1' },
    // A pod's loopback has no reachable backend; the ingress NetworkPolicy
    // is what takes over from the loopback bind (see policy-manifests).
    { name: 'YAAC_BIND_ADDR', value: '0.0.0.0' },
    { name: 'YAAC_SERVER_PORT', value: String(SERVER_POD_PORT) },
    { name: 'YAAC_DATA_DIR', value: getDataDir() },
    { name: 'YAAC_DRIVER', value: 'k8s' },
    { name: 'YAAC_RELAY_ADDR', value: proxyServiceHost(k8sNamespace(), RELAY_PORT) },
  ]
  const passThrough: Array<[string, string | undefined]> = [
    ['YAAC_K8S_NAMESPACE', testEnv.k8sNamespace],
    ['YAAC_IMAGE_PREFIX', testEnv.imagePrefix],
    ['YAAC_ALLOWED_HOSTS', env.allowedHosts.length > 0 ? env.allowedHosts.join(',') : undefined],
    ['YAAC_TRUST_PROXY', env.trustProxy ? '1' : undefined],
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
 * The lock's lease is the guard that actually enforces that on hostPath
 * storage (there is no attach exclusivity to fall back on), and the
 * strategy is what keeps the lease from having to arbitrate on every roll.
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
          // The uid every path the server pre-creates for a worktree pod is
          // owned by. Under gVisor the gofer presents that real ownership,
          // so the worktree image's `yaac` user is built with the same
          // number. Stamped from the installing host rather than pinned:
          // the data dir is a hostPath this machine owns, and no pod can
          // write it as anything else (see `podUid`).
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
              volumeMounts: [{ name: 'data', mountPath: getDataDir() }],
            },
          ],
          volumes: [
            // The real host data dir, at its real absolute path. kind binds
            // $HOME into every node, so this resolves to the same bytes the
            // host process wrote — which is the whole point of doing the
            // process move before the storage move.
            { name: 'data', hostPath: { path: getDataDir(), type: 'DirectoryOrCreate' } },
          ],
        },
      },
    },
  }
}

/**
 * The Service, published to the host as a fixed loopback origin.
 *
 * NodePort with a pinned port, fronted by a kind `extraPortMapping` written
 * at cluster-create time: the browser, the CLI and the desktop app then all
 * dial one stable `127.0.0.1:<port>` with no tunnel process for anyone to
 * keep alive. `externalTrafficPolicy` stays the default (`Cluster`), which
 * is what SNATs NodePort traffic to a node address — the source the ingress
 * policy admits.
 */
export function buildServerServiceManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: SERVER_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: SERVER_APP_NAME },
    },
    spec: {
      type: 'NodePort',
      selector: { app: SERVER_APP_NAME },
      ports: [{
        name: 'api',
        port: SERVER_POD_PORT,
        targetPort: SERVER_POD_PORT,
        nodePort: SERVER_NODE_PORT,
      }],
    },
  }
}

/**
 * Apply the server workload and wait for it to roll.
 *
 * Order matters twice: the SA and its ClusterRole exist before the pod that
 * mounts the token, and the ingress policy is applied before the Service
 * publishes the port — a window in which the API is reachable from pods is
 * a window in which a worktree could use it.
 */
export async function ensureServerDeployment(
  imageRef: string,
  envOpts: ServerEnvOptions = {},
): Promise<void> {
  await kubectlApply(buildServerServiceAccountManifest())
  await kubectlApply(buildServerClusterRoleManifest())
  await kubectlApply(buildServerClusterRoleBindingManifest())
  await kubectlApply(buildServerIngressNpManifest(await clusterPodCidrs()))
  await kubectlApply(buildServerDeploymentManifest(imageRef, envOpts))
  await kubectlApply(buildServerServiceManifest())
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
    '-n', k8sNamespace(),
    '--timeout=300s',
  ], { timeout: 310_000, maxAttempts: 2 })
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
function isLoopbackOnlyInstall(): boolean {
  return env.allowedHosts.length === 0 && !env.trustProxy && !env.requireAuth
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
  log: (message: string) => void = () => { /* quiet by default */ },
): Promise<void> {
  await registerServer(serverPublishedOrigin(), 'k8s', {
    log,
    // An empty token is right on the loopback install, where nothing
    // checks it. On a credential-REQUIRING one it is a lockout, and the
    // note printed before this promised it would not happen.
    credentialRequired: !isLoopbackOnlyInstall(),
  })
}

/**
 * Build the image, apply the workload, wait for the published origin to
 * answer, and point this machine's clients at it — the whole of "the
 * server now runs in the cluster", as one step `yaac cluster install`
 * injects and unit tests replace.
 *
 * Returns the origin it published, which is what install prints.
 */
export async function deployServerWorkload(
  opts: ServerEnvOptions & { log: (message: string) => void },
): Promise<string> {
  await refuseIfHostServerRunning()
  opts.log('Building the server image (from the bundle)...')
  const imageRef = await ensureServerImage()
  opts.log(`Deploying the yaac server (${imageRef})...`)
  // Pass the options straight through rather than re-listing the fields:
  // every `ServerEnvOptions` member is optional, so a hand-copied list lets
  // the next field added go missing from the Deployment with no compile error.
  await ensureServerDeployment(imageRef, opts)
  await waitForPublishedServer()
  if (!isLoopbackOnlyInstall()) {
    // Worth saying out loud, because it is the one setting here that can
    // arrive by accident: these are read from the environment `yaac cluster
    // install` runs in, and a shell that already has them (a machine
    // hosting another yaac remotely) hands them to a brand-new install that
    // did not ask for them.
    opts.log(
      'note: this server will REQUIRE a credential — YAAC_ALLOWED_HOSTS / '
      + 'YAAC_TRUST_PROXY is set in this environment and the Deployment '
      + 'carries it. server.json below gets a durable token so the CLI on '
      + 'this machine keeps working — and this install says so plainly if '
      + 'that mint fails. Unset them and re-install if it was not intended '
      + '(docs/remote-hosting.md).',
    )
  }
  // Also records that this data dir IS a k8s install, so a later `yaac
  // server start` from an ordinary shell finds the Deployment instead of
  // spawning a second server beside it.
  await writeServerRemote(opts.log)
  return serverPublishedOrigin()
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
 *  - `waitForPublishedServer` probes `127.0.0.1:<port>`, and on a cluster
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
 * Wait for the ROLLED server to answer on the host, and turn "it never
 * does" into the one diagnosis that explains it.
 *
 * A Deployment that is Available while `127.0.0.1:<port>` refuses is not a
 * server problem — it is a cluster created before the port mapping existed,
 * so the NodePort has no host end and nothing published it. That cannot be
 * converged in place (kind writes port mappings at create time only), so
 * the message says the only thing that fixes it.
 */
export async function waitForPublishedServer(
  timeoutMs = PUBLISH_PROBE_TIMEOUT_MS,
): Promise<void> {
  const origin = serverPublishedOrigin()
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
    + '    This is what a cluster created before the server was published looks '
    + 'like: the NodePort has no host end, and kind writes port mappings only '
    + 'when a cluster is created.\n'
    + '    Recreate it: `yaac cluster delete`, then `yaac cluster install`. '
    + 'Running worktrees are lost (as any cluster delete loses them); nothing '
    + 'under the data dir is touched.',
  )
}

/**
 * `yaac server start` against an install whose server is a Deployment:
 * scale it back to one and wait. The counterpart to `stopClusterServer`,
 * and NOT a substitute for `yaac cluster install` — it starts the server
 * that is already deployed, it does not deploy one.
 */
export async function startClusterServer(): Promise<void> {
  await scaleServerDeployment(1)
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
    '-n', k8sNamespace(), '--timeout=300s',
  ], { timeout: 310_000, maxAttempts: 2 })
  await waitForPublishedServer()
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
 * `yaac server restart`: roll the pod. `Recreate` means the old pod is gone
 * before the new one is scheduled, so the lease never has two holders.
 */
export async function restartClusterServer(): Promise<void> {
  await kubectlWithRetry([
    'rollout', 'restart', `deployment/${SERVER_APP_NAME}`, '-n', k8sNamespace(),
  ], { timeout: 60_000 })
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
    '-n', k8sNamespace(), '--timeout=300s',
  ], { timeout: 310_000, maxAttempts: 2 })
  await waitForPublishedServer()
}
