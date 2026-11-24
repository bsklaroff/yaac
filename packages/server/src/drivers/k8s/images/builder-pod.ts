/**
 * Ephemeral gVisor builder pods for untrusted layers (project images and
 * `Dockerfile.user`), each running its own buildkitd (docs/image-builds.md).
 * Each `buildImageLayers` call gets one pod, shared by its untrusted layers
 * through a `BuilderPodLease`, so the second layer's parent is already
 * local. Per layer:
 *
 *   1. stream the build context (the revision's support files) in as a tar
 *      over `kubectl exec -i`, and the Dockerfile with the normalize step
 *      appended;
 *   2. hand the pod a registry grant for only this layer's repo, its parent
 *      and the project's build-cache repo, and a source policy;
 *   3. run one `buildctl build` that pulls the parent lazily, imports and
 *      exports the layer's registry cache, and pushes the product.
 *
 * buildkitd listens on a socket in its own container, which a `RUN` step's
 * container does not see, and the grant is read only by `buildctl`.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  LABEL_BUILD_ID,
  LABEL_INSTALL_ID,
  LABEL_PROJECT_ID,
  LABEL_PROXY_INPUT,
  LABEL_ROLE,
  PRIORITY_CLASS_BUILDER,
  ROLE_BUILDER,
  RUNTIME_CLASS_GVISOR,
  applyObject,
  buildContextFiles,
  installId,
  deleteObject,
  listObjects,
  ensureKubernetes,
  execFileAsync,
  sentryTmpfsAnnotations,
  k8sNamespace,
  readObject,
  runStreamingProcess,
  streamBuildContext,
} from '#drivers/k8s/substrate'
import {
  BUILDKITD_ENV,
  NORMALIZE_STEP,
  buildBuildRegistrationConfigMapManifest,
  buildBuilderEgressNpManifest,
  buildkitdConfig,
  ensureBuilderImage,
  ensureBuilderRoleGuard,
  ensureMainRegistry,
  nodeIpBlocks,
  proxyRegistrationName,
  proxyServiceClusterIp,
  registryAuthFile,
  registryHost,
  registryPodHost,
  registryRepoIsProtected,
  stringHash,
  type ImageLayer,
} from '#drivers/k8s/cluster'
import { proxyClient } from '#drivers/k8s/egress'
import { serverLog } from '#lib/log'

interface EngineBuildContext {
  /** Project whose chain is being built (its id keys the cache repo). */
  projectId: string
  /** The id the builder's egress is registered under. */
  egressId: string
  /** The project's allowed hosts (`BuilderPodIdentity`). */
  allowedHosts: string[]
  onLog?: (line: string) => void
  /** Builder pod shared by adjacent untrusted layers of one request, owned
   *  and released by the coordinator. */
  lease: BuilderPodLease
  /** Import no cache and start a new one (a rebuild without cache). */
  noCache?: boolean
  /** The cache's maximum age in days (`cacheBucket`). */
  cacheMaxDays?: number
}

interface BuilderPodIdentity {
  projectId: string
  /** The first build the pod runs, which the proxy knows its egress by. */
  buildId: string
  /** The project's allowed hosts: all a build may reach, through the proxy. */
  allowedHosts: string[]
}

/** When this server process started: builder objects older than it are
 *  leaks from the last one (`deleteLeakedBuilderPods`). */
const PROCESS_STARTED_AT = Date.now()

/**
 * In-container directory of buildkitd's state, and its volume (the gVisor
 * mount annotations key on the name). It must be a sentry-internal tmpfs:
 * gVisor's gofer filesystem rejects the overlay upper dirs and `security.*`
 * xattrs a build writes.
 */
const BUILDER_STATE_PATH = '/var/lib/buildkit'
const BUILDER_STATE_VOLUME = 'buildkit-state'

/**
 * In-sandbox capabilities buildkitd and runc need. Under gVisor they grant
 * no host authority:
 *  - SYS_ADMIN, SYS_CHROOT: the snapshot mounts and each step's container.
 *  - MKNOD: device nodes in image layers.
 *  - SETFCAP: `setcap` in build steps.
 *  - NET_RAW, NET_ADMIN: raw sockets and route config in RUN steps.
 *  - SYS_PTRACE, SYS_RESOURCE: debuggers and rlimit raises.
 */
const BUILDER_ENGINE_CAPS = [
  'SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'SETFCAP',
  'NET_RAW', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_RESOURCE',
]

/**
 * Sentry tmpfs cap for buildkitd's state. A build holds the parent chain
 * twice (its compressed blobs and their unpacked snapshots, ~10GB for the
 * stock tools image), its own layers and the cache it exports.
 */
export const BUILDER_STATE_TMPFS_BYTES = 24 * 1024 ** 3

/** emptyDir sizeLimit, above the tmpfs cap so the sentry hits ENOSPC
 *  before kubelet evicts the pod. */
export const BUILDER_STATE_SIZELIMIT_BYTES = BUILDER_STATE_TMPFS_BYTES + 1024 ** 3

/** Pod memory limit for build processes (layer data is disk-backed). */
export const BUILDER_MEMORY_LIMIT_BYTES = 8 * 1024 ** 3

/**
 * Memory request, well under the limit. Set explicitly because Kubernetes
 * defaults a missing request to the limit, and reserving 8Gi would crowd
 * out several workspaces on a busy node.
 */
export const BUILDER_MEMORY_REQUEST_BYTES = 2 * 1024 ** 3

/** CPU request with no limit, so builds use an idle node fully. */
export const BUILDER_CPU_REQUEST_MILLIS = 500

/**
 * Maximum builder pod lifetime: the only total cap on a build, since the
 * per-step budgets below are idle timeouts. It catches a pod the server
 * abandoned and a stuck build that keeps printing output. Four hours is an
 * arbitrary value well above any real build.
 */
export const BUILDER_ACTIVE_DEADLINE_SECONDS = 4 * 3600

/**
 * Per-step exec budgets (ms). All are idle timeouts (time since the step
 * last printed; see substrate/streaming-proc.ts) except the readiness wait,
 * which is a total.
 */
const BUILDER_READY_TIMEOUT_MS = 60_000
export const BUILDER_BUILD_IDLE_TIMEOUT_MS = 600_000
const BUILDER_CONTEXT_IDLE_TIMEOUT_MS = 120_000

/** Hard cap on any one exec: past the pod's own deadline. */
const BUILDER_EXEC_TOTAL_TIMEOUT_MS = (BUILDER_ACTIVE_DEADLINE_SECONDS + 300) * 1000

/** A cache's default maximum age, in days. */
export const BUILD_CACHE_MAX_DAYS = 28

/** In-pod paths: the context, the Dockerfile as built, and the policy. */
export const BUILDER_CONTEXT_DIR = '/tmp/yaac-build-ctx'
export const BUILDER_DOCKERFILE_DIR = '/tmp/yaac-build-dockerfile'
const BUILDER_POLICY_FILE = '/tmp/yaac-source-policy.json'

/** Where buildctl reads registry credentials (`$DOCKER_CONFIG`, default). */
export const BUILDER_AUTHFILE = '/root/.docker/config.json'

/**
 * Per-project registry repo for build caches. Cache entries are used
 * without a provenance check, so a hostile build could poison later hits;
 * a per-project repo limits that to the project the attacker already
 * controls. Named by project id, so a new project starts with an empty
 * cache.
 */
function buildCacheRepo(projectId: string): string {
  return `yaac-buildcache-${projectId}`
}

/** `repo` of a `repo:tag`. */
function registryRepoOf(tag: string): string {
  const colon = tag.lastIndexOf(':')
  return colon < 0 ? tag : tag.slice(0, colon)
}

/**
 * Which cache a build of `layer` uses: `<repo>:<layer>-<bucket>`. Time is
 * cut into windows of `maxDays`, offset per project so projects do not all
 * start a new cache on one day, and a window's cache is never read after it
 * ends. That bounds how long a poisoned entry can outlive the Dockerfile
 * that planted it, with no stored start date. The registry GC keeps only
 * each layer's newest window.
 */
export function cacheBucket(projectId: string, maxDays: number, now = Date.now()): number {
  const offset = Number.parseInt(stringHash(projectId).slice(0, 8), 16) % maxDays
  return Math.floor((Math.floor(now / 86_400_000) + offset) / maxDays)
}

/**
 * The repos a layer's build may use: its own product repo, the project's
 * cache repo, and its parent's repo when that is protected (a user layer
 * over its project's). A hostile `RUN` step that reads the grant can reach
 * nothing another project or the trusted chain owns.
 */
function builderGrantRepos(layer: ImageLayer, projectId: string): string[] {
  const parent = layer.buildArgs?.BASE_IMAGE
  return [
    registryRepoOf(layer.tag),
    buildCacheRepo(projectId),
    ...(parent && registryRepoIsProtected(registryRepoOf(parent)) ? [registryRepoOf(parent)] : []),
  ]
}

/**
 * The source policy for one build: every image on the main registry is
 * denied, at either port, except the layer's own parent. So a Dockerfile
 * cannot `FROM` or `COPY --from` another project's image through the
 * daemon. The gate's read check is what holds; this makes a hostile
 * Dockerfile fail early and clearly. Later rules win in BuildKit.
 */
export function builderSourcePolicy(parentTag: string | undefined): string {
  const deny = [registryHost(), registryPodHost()].map((host) => ({
    action: 'DENY',
    selector: { identifier: `docker-image://${host}/*`, matchType: 'WILDCARD' },
  }))
  const allow = parentTag
    ? [{
      action: 'ALLOW',
      selector: { identifier: `docker-image://${registryPodHost()}/${parentTag}*`, matchType: 'WILDCARD' },
    }]
    : []
  return JSON.stringify({ rules: [...deny, ...allow] })
}

/** Builder pod name: a hash of the first layer tag plus random bytes. */
function builderPodName(seedTag: string): string {
  return `yaac-builder-${stringHash(seedTag).slice(0, 8)}-${crypto.randomBytes(2).toString('hex')}`
}

/**
 * Builder pod manifest: the `gvisor` runtime, the engine capabilities, no
 * service account token, and buildkitd's state on a sentry-internal tmpfs.
 * buildkitd is the entrypoint, with its config written from the env at
 * start; the server drives it with `kubectl exec … buildctl`.
 */
function buildBuilderPodManifest(
  name: string,
  imageRef: string,
  identity: BuilderPodIdentity,
  proxyIp: string,
): Record<string, unknown> {
  const config = buildkitdConfig({ plainHttp: [registryPodHost()] })
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: {
        [LABEL_INSTALL_ID]: installId(),
        [LABEL_ROLE]: ROLE_BUILDER,
        [LABEL_PROJECT_ID]: identity.projectId,
        [LABEL_BUILD_ID]: identity.buildId,
      },
      annotations: sentryTmpfsAnnotations(BUILDER_STATE_VOLUME, BUILDER_STATE_TMPFS_BYTES),
    },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: BUILDER_ACTIVE_DEADLINE_SECONDS,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      runtimeClassName: RUNTIME_CLASS_GVISOR,
      // Outranks workspaces but never preempts one (see priority-classes.ts).
      priorityClassName: PRIORITY_CLASS_BUILDER,
      // The proxy's DNS stub, as a workspace's: it resolves the registry
      // and sinkholes every other name, since netd redirects the build's
      // egress and the proxy routes by SNI/Host.
      dnsPolicy: 'None',
      dnsConfig: { nameservers: [proxyIp] },
      securityContext: {
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [{
        name: 'builder',
        image: imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: [
          'sh', '-c',
          'printf %s "$BUILDKITD_CONFIG" > /etc/buildkit/buildkitd.toml '
          + '&& exec buildkitd --config /etc/buildkit/buildkitd.toml --oci-worker-net=host',
        ],
        env: [
          { name: 'BUILDKITD_CONFIG', value: config },
          ...Object.entries(BUILDKITD_ENV).map(([key, value]) => ({ name: key, value })),
        ],
        securityContext: {
          capabilities: { add: BUILDER_ENGINE_CAPS },
        },
        resources: {
          requests: {
            cpu: `${BUILDER_CPU_REQUEST_MILLIS}m`,
            memory: String(BUILDER_MEMORY_REQUEST_BYTES),
          },
          limits: { memory: String(BUILDER_MEMORY_LIMIT_BYTES) },
        },
        volumeMounts: [{
          name: BUILDER_STATE_VOLUME,
          mountPath: BUILDER_STATE_PATH,
        }],
      }],
      volumes: [{
        name: BUILDER_STATE_VOLUME,
        emptyDir: { sizeLimit: String(BUILDER_STATE_SIZELIMIT_BYTES) },
      }],
    },
  }
}

/** Wait for buildkitd to answer on its socket; the pod is Ready before it is. */
const WAIT_FOR_BUILDKITD = 'for i in $(seq 120); do buildctl debug workers >/dev/null 2>&1 && exit 0; sleep 0.5; done; '
  + 'echo "buildkitd did not start" >&2; exit 1'

/**
 * `buildctl build` argv for one layer. `BASE_IMAGE` is the parent's pod-port
 * ref, so BuildKit pulls it only if a step has to run. The output is one
 * zstd image manifest with no attestations, which the registry GC requires
 * (docs/image-gc.md), and so is the cache export.
 */
function builderBuildArgs(
  layer: ImageLayer,
  opts: { cacheRef: string; noCache: boolean },
): string[] {
  const host = registryPodHost()
  const args = [
    'build',
    '--frontend', 'dockerfile.v0',
    '--local', `context=${BUILDER_CONTEXT_DIR}`,
    '--local', `dockerfile=${BUILDER_DOCKERFILE_DIR}`,
    // Parse with the built-in frontend even if the file names another.
    '--opt', 'cmdline=dockerfile.v0',
    '--source-policy-file', BUILDER_POLICY_FILE,
    '--export-cache', `type=registry,ref=${opts.cacheRef},mode=max,image-manifest=true,oci-mediatypes=true`,
    ...(opts.noCache ? ['--no-cache'] : ['--import-cache', `type=registry,ref=${opts.cacheRef}`]),
    '--output', `type=image,name=${host}/${layer.tag},push=true,compression=zstd,oci-mediatypes=true`,
    '--progress', 'plain',
  ]
  for (const [key, value] of Object.entries(layer.buildArgs ?? {})) {
    args.push('--opt', `build-arg:${key}=${key === 'BASE_IMAGE' ? `${host}/${value}` : value}`)
  }
  return args
}

interface PodExecOptions {
  /** stdin, e.g. the context tar. */
  input?: NodeJS.ReadableStream
  onLog?: (line: string) => void
  logPrefix: string
  /** Idle timeout (see substrate/streaming-proc.ts). */
  idleTimeoutMs: number
}

/**
 * `kubectl exec -i` into the builder pod, streaming output lines to the
 * server log and the caller.
 */
async function execInBuilderPod(
  podName: string,
  command: string[],
  opts: PodExecOptions,
): Promise<void> {
  const args = ['exec', '-i', '-n', k8sNamespace(), `pod/${podName}`, '--', ...command]
  await runStreamingProcess('kubectl', args, {
    input: opts.input,
    onLog: opts.onLog,
    logPrefix: opts.logPrefix,
    idleTimeoutMs: opts.idleTimeoutMs,
    timeoutMs: BUILDER_EXEC_TOTAL_TIMEOUT_MS,
    label: `builder exec [${command.join(' ').slice(0, 120)}]`,
    tailLines: 20,
  })
}

/** Write `content` to `file` in the pod, over stdin, private to root. */
async function writePodFile(
  podName: string,
  file: string,
  content: string,
  opts: { onLog?: (line: string) => void; logPrefix: string },
): Promise<void> {
  await execInBuilderPod(
    podName,
    ['sh', '-c', `umask 077 && mkdir -p ${path.posix.dirname(file)} && cat > ${file}`],
    { ...opts, input: Readable.from([content]), idleTimeoutMs: BUILDER_CONTEXT_IDLE_TIMEOUT_MS },
  )
}

/**
 * Stream the context into a freshly wiped BUILDER_CONTEXT_DIR (a reused pod
 * still has the previous layer's context).
 */
async function streamContextToPod(
  podName: string,
  contextDir: string,
  opts: { onLog?: (line: string) => void; logPrefix: string },
): Promise<void> {
  const extract = `rm -rf ${BUILDER_CONTEXT_DIR} && mkdir -p ${BUILDER_CONTEXT_DIR} `
    + `&& tar -xf - -C ${BUILDER_CONTEXT_DIR}`
  await streamBuildContext(contextDir, await buildContextFiles(contextDir), opts.logPrefix, (tar) =>
    execInBuilderPod(podName, ['sh', '-c', extract], {
      ...opts, input: tar, idleTimeoutMs: BUILDER_CONTEXT_IDLE_TIMEOUT_MS,
    }))
}

/** Apply the builder-role admission guard and egress policy. */
async function ensureBuilderNetworkPolicies(): Promise<void> {
  await ensureBuilderRoleGuard()
  await applyObject(buildBuilderEgressNpManifest(await nodeIpBlocks()))
}

/**
 * One builder pod, created on first `acquire` and shared by the untrusted
 * layers of one `buildImageLayers` call, which calls `release` to delete it.
 */
export class BuilderPodLease {
  private podName: string | null = null
  private acquiring: Promise<string> | null = null
  private buildId: string | null = null
  /** Once released, it provisions nothing more. */
  private released = false


  async acquire(seedTag: string, identity: BuilderPodIdentity): Promise<string> {
    if (this.released) throw new Error('cancelled')
    if (!this.acquiring) {
      this.acquiring = this.provision(seedTag, identity).catch((err: unknown) => {
        this.acquiring = null // a later layer may retry provisioning
        throw err
      })
    }
    return this.acquiring
  }

  private async provision(seedTag: string, identity: BuilderPodIdentity): Promise<string> {
    try {
      await ensureKubernetes()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        'Project images and Dockerfile.user build in sandboxed cluster '
        + 'pods, which needs a healthy cluster. '
        + `Run \`yaac cluster check\`.\n${detail}`,
      )
    }
    // Fail here, not inside the pod, if the registry is not up. The pod
    // resolves names and reaches the network through the proxy, which a
    // server that has launched no workspace yet has not deployed.
    await ensureMainRegistry()
    await proxyClient.ensureRunning()
    const imageRef = await ensureBuilderImage()
    await ensureBuilderNetworkPolicies()

    const name = builderPodName(seedTag)
    serverLog(`[builder] creating builder pod ${name}`)
    // Before the pod, so its first dial finds it (the proxy fails closed).
    await applyObject(buildBuildRegistrationConfigMapManifest(identity.buildId, identity.projectId, identity.allowedHosts))
    this.buildId = identity.buildId
    await applyObject(buildBuilderPodManifest(name, imageRef, identity, await proxyServiceClusterIp()))
    try {
      // `kubectl wait`: the substrate's watch-based wait is for Job pods.
      await execFileAsync('kubectl', [
        'wait', '--for=condition=Ready', `pod/${name}`, '-n', k8sNamespace(),
        `--timeout=${Math.floor(BUILDER_READY_TIMEOUT_MS / 1000)}s`,
      ], { timeout: BUILDER_READY_TIMEOUT_MS + 15_000 })
      await execInBuilderPod(name, ['sh', '-c', WAIT_FOR_BUILDKITD], {
        logPrefix: `[builder ${name}] `,
        idleTimeoutMs: 90_000,
      })
    } catch (err) {
      const blocked = await builderPodBlockDetail(name)
      await deleteBuilderPod(name)
      if (!blocked) throw err
      throw new Error(`${err instanceof Error ? err.message : String(err)}\n${blocked}`)
    }
    this.podName = name
    return name
  }

  /** Delete the pod and its registration. Best-effort: activeDeadlineSeconds
   *  bounds a leaked pod, and the next server's start deletes both. */
  async release(): Promise<void> {
    this.released = true
    const pending = this.acquiring
    this.acquiring = null
    const name = this.podName ?? (pending ? await pending.catch(() => null) : null)
    this.podName = null
    if (name) await deleteBuilderPod(name)
    if (this.buildId) await deleteBuildRegistration(this.buildId)
  }
}

interface BuilderPodStatus {
  status?: {
    phase?: string
    /** Pod-level reason, e.g. `DeadlineExceeded`. */
    reason?: string
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
    containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }>
  }
}

/**
 * One-line reason a builder pod failed, from its status: hit its deadline,
 * never scheduled, or its container is stuck waiting (e.g. image pull).
 * `kubectl wait` only reports a timeout. Null when the status says nothing
 * useful.
 */
function builderPodBlockReason(pod: BuilderPodStatus | null): string | null {
  if (pod?.status?.reason === 'DeadlineExceeded') {
    return 'stopped at the whole-pod deadline '
      + `(activeDeadlineSeconds=${BUILDER_ACTIVE_DEADLINE_SECONDS}) — the build `
      + 'was still producing output, so no per-step idle budget applied'
  }
  const unscheduled = pod?.status?.conditions
    ?.find((c) => c.type === 'PodScheduled' && c.status !== 'True')
  if (unscheduled) {
    return `not scheduled (${unscheduled.reason ?? 'unknown'})`
      + (unscheduled.message ? `: ${unscheduled.message}` : '')
  }
  const waiting = pod?.status?.containerStatuses
    ?.find((c) => c.state?.waiting?.reason)?.state?.waiting
  if (waiting) {
    return `container waiting (${waiting.reason})`
      + (waiting.message ? `: ${waiting.message}` : '')
  }
  return null
}

/** Live-status wrapper around `builderPodBlockReason` (best effort). */
async function builderPodBlockDetail(name: string): Promise<string | null> {
  const pod = await readObject<BuilderPodStatus>({
    apiVersion: 'v1', kind: 'Pod', name, namespace: k8sNamespace(),
  }).catch(() => null)
  const reason = builderPodBlockReason(pod)
  return reason ? `builder pod ${name}: ${reason}` : null
}

async function deleteBuildRegistration(buildId: string): Promise<void> {
  await deleteObject({
    apiVersion: 'v1', kind: 'ConfigMap', name: proxyRegistrationName(buildId), namespace: k8sNamespace(),
  }).catch((err: unknown) => {
    serverLog(`[builder] failed to delete the egress registration of build ${buildId}: ${String(err)}`)
  })
}

async function deleteBuilderPod(name: string): Promise<void> {
  await deleteObject({ apiVersion: 'v1', kind: 'Pod', name, namespace: k8sNamespace() }).catch((err: unknown) => {
    serverLog(`[builder] failed to delete pod ${name}: ${String(err)}`)
  })
}

/**
 * Build one layer in the lease's builder pod and push it. The lease's
 * owner, not this function, deletes the pod.
 */
export async function buildLayerInPod(
  layer: ImageLayer,
  ctx: EngineBuildContext,
): Promise<void> {
  const pod = await ctx.lease.acquire(layer.tag, {
    projectId: ctx.projectId, buildId: ctx.egressId, allowedHosts: ctx.allowedHosts,
  })
  const execOpts = { onLog: ctx.onLog, logPrefix: `[build ${layer.tag}] ` }
  try {
    await runLayerBuild(pod, layer, ctx, execOpts)
  } catch (err) {
    // If the pod died (e.g. its deadline), kubectl only reports a signal,
    // so ask the pod why.
    const blocked = await builderPodBlockDetail(pod)
    if (!blocked) throw err
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${blocked}`)
  }
}

async function runLayerBuild(
  pod: string,
  layer: ImageLayer,
  ctx: EngineBuildContext,
  execOpts: { onLog?: (line: string) => void; logPrefix: string },
): Promise<void> {
  await streamContextToPod(pod, layer.context, execOpts)
  await writePodFile(pod, `${BUILDER_DOCKERFILE_DIR}/Dockerfile`, `${layer.dockerfile}\n${NORMALIZE_STEP}`, execOpts)
  await writePodFile(pod, BUILDER_POLICY_FILE, builderSourcePolicy(layer.buildArgs?.BASE_IMAGE), execOpts)
  // Each layer gets a fresh grant, valid for the pod's lifetime.
  await writePodFile(pod, BUILDER_AUTHFILE, await registryAuthFile(
    registryPodHost(),
    builderGrantRepos(layer, ctx.projectId),
    BUILDER_ACTIVE_DEADLINE_SECONDS + 60,
  ), execOpts)

  const bucket = cacheBucket(ctx.projectId, ctx.cacheMaxDays ?? BUILD_CACHE_MAX_DAYS)
  await execInBuilderPod(
    pod,
    ['buildctl', ...builderBuildArgs(layer, {
      cacheRef: `${registryPodHost()}/${buildCacheRepo(ctx.projectId)}:${layer.name}-${layer.cacheKey ?? 'none'}-${bucket}`,
      noCache: ctx.noCache ?? false,
    })],
    { ...execOpts, idleTimeoutMs: BUILDER_BUILD_IDLE_TIMEOUT_MS },
  )
}

/**
 * Delete every builder pod of this install, and every build registration,
 * older than this server process, at server start. Only one
 * server runs per install (its Deployment is `replicas: 1` with `Recreate`,
 * so the old pod is gone before this one starts), so any builder pod then
 * is a leak from the last one, and its memory reservation could block
 * every build after a restart.
 * During the server's life `release` deletes pods inline, and a leaked one
 * is bounded by its activeDeadlineSeconds.
 */
export async function deleteLeakedBuilderPods(): Promise<void> {
  const namespace = k8sNamespace()
  for (const [kind, labelSelector] of [
    ['Pod', `${LABEL_ROLE}=${ROLE_BUILDER},${LABEL_INSTALL_ID}=${installId()}`],
    // Their registrations, which the namespace's proxy alone reads.
    ['ConfigMap', `${LABEL_PROXY_INPUT}=registration,${LABEL_BUILD_ID}`],
  ] as const) {
    for (const obj of await listObjects('v1', kind, { namespace, labelSelector })) {
      // A build this server started before the sweep ran is not a leak.
      const created = Date.parse(obj.metadata?.creationTimestamp as unknown as string)
      if (!(created < PROCESS_STARTED_AT)) continue
      await deleteObject({ apiVersion: 'v1', kind, name: obj.metadata!.name!, namespace })
    }
  }
}
