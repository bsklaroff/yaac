/**
 * Ephemeral runsc builder pods for untrusted layers (`Dockerfile.yaac`,
 * `Dockerfile.user`), which never run on the host podman engine
 * (docs/trust-split-builds.md). Each `ensureImage` call gets one gVisor pod
 * running podman, shared by its untrusted layers through a
 * `BuilderPodLease`. Per layer:
 *
 *   1. on pod creation, write a storage.conf using native overlay (the
 *      stock image's fuse-overlayfs does not work under runsc),
 *   2. pull the parent from the registry and retag it to the bare tag so
 *      `--build-arg BASE_IMAGE=P` resolves,
 *   3. stream the build context in as a tar over `kubectl exec -i`,
 *      honoring `.containerignore` like `contextHash()`,
 *   4. give the pod a registry write grant for only this layer's repo and
 *      the project's step-cache repo,
 *   5. `podman build --isolation chroot` with the registry step cache,
 *   6. push the product (parent blobs are cross-repo mounted, not
 *      re-uploaded),
 *   7. delete the pod (the next server's start deletes a leaked one).
 *
 * Parents, products and step-cache images all live in the registry; the
 * host store never sees these tags.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { registryAuthFile, registryHost } from '#drivers/k8s/container'
import { BUILDER_CONTEXT_MAX_BYTES, collectContextFiles, parseContainerIgnore } from '#lib/build-context'
import {
  LABEL_DATA_DIR_HASH,
  LABEL_ROLE,
  NESTED_ENGINE_CAPS,
  NESTED_GRAPHROOT_PATH,
  NESTED_GRAPHROOT_VOLUME,
  PRIORITY_CLASS_BUILDER,
  ROLE_BUILDER,
  RUNTIME_CLASS_GVISOR,
  applyObject,
  dataDirHash,
  deleteObject,
  deleteObjects,
  ensureKubernetes,
  execFileAsync,
  sentryTmpfsAnnotations,
  k8sNamespace,
  readObject,
} from '#drivers/k8s/substrate'
import {
  wideEgress,
  ensureBuilderImage,
  ensureBuilderRoleGuard,
  ensureMainRegistry,
  nodeIpBlocks,
} from '#drivers/k8s/cluster'
import { runStreamingProcess } from '#drivers/k8s/container'
import { serverLog, pipeToServerLog } from '#log'
import { stringHash, type ImageLayer } from '#drivers/k8s/image-engine'

interface EngineBuildContext {
  /** Project whose chain is being built (its id keys the step-cache repo). */
  projectId: string
  onLog?: (line: string) => void
  /** Builder pod shared by adjacent untrusted layers of one request, owned
   *  and released by the coordinator. */
  lease: BuilderPodLease
}

/**
 * Sentry tmpfs cap for the builder graphroot. Larger than a workspace
 * pod's because a build holds the parent chain (~5GB), its product and
 * step-cache images at once.
 */
export const BUILDER_GRAPHROOT_TMPFS_BYTES = 16 * 1024 ** 3

/** emptyDir sizeLimit, above the tmpfs cap so the sentry hits ENOSPC
 *  before kubelet evicts the pod. */
export const BUILDER_GRAPHROOT_SIZELIMIT_BYTES = BUILDER_GRAPHROOT_TMPFS_BYTES + 1024 ** 3

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
 * last printed; see container/streaming-proc.ts) except the readiness wait,
 * which is a total.
 */
const BUILDER_READY_TIMEOUT_MS = 60_000
const BUILDER_PULL_IDLE_TIMEOUT_MS = 180_000
export const BUILDER_BUILD_IDLE_TIMEOUT_MS = 600_000
const BUILDER_PUSH_IDLE_TIMEOUT_MS = 120_000
const BUILDER_CONTEXT_IDLE_TIMEOUT_MS = 120_000

/** Hard cap on any one exec: past the pod's own deadline. */
const BUILDER_EXEC_TOTAL_TIMEOUT_MS = (BUILDER_ACTIVE_DEADLINE_SECONDS + 300) * 1000

/**
 * `--cache-ttl` for step-cache reads. Older entries are misses, so stale or
 * poisoned cache ages out and GC knows how long entries matter.
 */
export const BUILD_CACHE_TTL = '168h'

/** In-pod path the build context is extracted to. */
export const BUILDER_CONTEXT_DIR = '/tmp/yaac-build-ctx'

/**
 * Per-project registry repo for step-cache images. Cache entries are used
 * without a provenance check, so a hostile build could poison later hits;
 * a per-project repo limits that to the project the attacker already
 * controls. Named by project id, so a new project starts with an empty
 * cache.
 */
function buildCacheRepo(projectId: string): string {
  return `yaac-buildcache-${projectId}`
}

/** In-pod path of the build's registry authfile (`--authfile`). */
export const BUILDER_AUTHFILE = '/run/yaac-registry-auth.json'

/**
 * The repos a layer's build may write: its own product repo and the
 * project's step-cache repo. A hostile `RUN` step that reads the grant can
 * write nothing another project or the trusted chain uses.
 */
function builderGrantRepos(layer: ImageLayer, projectId: string): string[] {
  return [layer.tag.slice(0, layer.tag.lastIndexOf(':')), buildCacheRepo(projectId)]
}

/** Builder pod name: a hash of the first layer tag plus random bytes. */
function builderPodName(seedTag: string): string {
  return `yaac-builder-${stringHash(seedTag).slice(0, 8)}-${crypto.randomBytes(2).toString('hex')}`
}

/**
 * Builder pod manifest: plain `gvisor` runtime (chroot builds need no raw
 * sockets), the nested-engine capabilities, no service account token, and
 * the graphroot on a sentry-internal tmpfs. The container just sleeps; the
 * server drives it with `kubectl exec` and streams the build logs.
 */
function buildBuilderPodManifest(name: string, imageRef: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: {
        [LABEL_DATA_DIR_HASH]: dataDirHash(),
        [LABEL_ROLE]: ROLE_BUILDER,
      },
      annotations: sentryTmpfsAnnotations(NESTED_GRAPHROOT_VOLUME, BUILDER_GRAPHROOT_TMPFS_BYTES),
    },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: BUILDER_ACTIVE_DEADLINE_SECONDS,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      runtimeClassName: RUNTIME_CLASS_GVISOR,
      // Outranks workspaces but never preempts one (see priority-classes.ts).
      priorityClassName: PRIORITY_CLASS_BUILDER,
      securityContext: {
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [{
        name: 'builder',
        image: imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: ['sleep', 'infinity'],
        securityContext: {
          capabilities: { add: NESTED_ENGINE_CAPS },
        },
        resources: {
          requests: {
            cpu: `${BUILDER_CPU_REQUEST_MILLIS}m`,
            memory: String(BUILDER_MEMORY_REQUEST_BYTES),
          },
          limits: { memory: String(BUILDER_MEMORY_LIMIT_BYTES) },
        },
        volumeMounts: [{
          name: NESTED_GRAPHROOT_VOLUME,
          mountPath: NESTED_GRAPHROOT_PATH,
        }],
      }],
      volumes: [{
        name: NESTED_GRAPHROOT_VOLUME,
        emptyDir: { sizeLimit: String(BUILDER_GRAPHROOT_SIZELIMIT_BYTES) },
      }],
    },
  }
}

/**
 * Replace the stock storage.conf, which forces fuse-overlayfs (broken under
 * runsc), with native overlay. `pull_options` keeps zstd:chunked partial
 * pulls enabled, as in the stock file.
 */
function builderStorageConfScript(): string {
  return [
    'set -eu',
    'mkdir -p /etc/containers',
    "cat > /etc/containers/storage.conf <<'EOF'",
    '[storage]',
    'driver = "overlay"',
    'runroot = "/run/containers/storage"',
    'graphroot = "/var/lib/containers/storage"',
    '',
    '[storage.options]',
    'pull_options = {enable_partial_images = "true", use_hard_links = "false", ostree_repos = ""}',
    'EOF',
  ].join('\n')
}

/**
 * Pull the parent image into the pod and retag it to the bare tag, since
 * `FROM ${BASE_IMAGE}` resolves locally. Skipped when the pod already has
 * it (a reused pod just built the previous layer).
 */
function builderParentPullScript(parentTag: string, clusterHost: string): string {
  const remote = `${clusterHost}/${parentTag}`
  return [
    'set -eu',
    `if podman image exists ${parentTag}; then exit 0; fi`,
    `podman pull --tls-verify=false ${remote}`,
    `podman tag ${remote} ${parentTag}`,
  ].join('\n')
}

/**
 * `podman build` argv (everything after `podman`). There is no `--no-cache`
 * option: a layer only builds when its content-hash tag is missing, and the
 * step cache only matches unchanged steps.
 */
function builderBuildArgs(
  layer: ImageLayer,
  opts: {
    dockerfileRel: string
    clusterHost: string
    cacheRepo: string
  },
): string[] {
  // With the registry step cache, an edited Dockerfile reruns only its
  // changed steps, even in a fresh pod.
  const cacheRef = `${opts.clusterHost}/${opts.cacheRepo}`
  const args = [
    'build',
    // RUN steps run in a chroot rather than a nested OCI runtime.
    '--isolation', 'chroot',
    '--tls-verify=false',
    '--authfile', BUILDER_AUTHFILE,
    '-t', layer.tag,
    '-f', `${BUILDER_CONTEXT_DIR}/${opts.dockerfileRel}`,
    '--cache-from', cacheRef,
    '--cache-to', cacheRef,
    '--cache-ttl', BUILD_CACHE_TTL,
  ]
  for (const [key, value] of Object.entries(layer.buildArgs ?? {})) {
    args.push('--build-arg', `${key}=${value}`)
  }
  args.push(BUILDER_CONTEXT_DIR)
  return args
}

interface BuildContextPlan {
  /** Context-relative file paths, sorted; the exact `contextHash()` set. */
  files: string[]
  /** Dockerfile path relative to the context root. */
  dockerfileRel: string
  totalBytes: number
}

/**
 * Enumerate the files to stream into the pod: the same set `contextHash()`
 * covers (honoring `.containerignore`, no symlinks), plus the Dockerfile
 * itself even when ignored (podman reads `-f` outside the ignore rules).
 * Enforces BUILDER_CONTEXT_MAX_BYTES.
 */
async function planBuildContext(
  contextDir: string,
  dockerfilePath: string,
): Promise<BuildContextPlan> {
  let ignore = new Set<string>()
  try {
    ignore = parseContainerIgnore(
      await fs.readFile(path.join(contextDir, '.containerignore'), 'utf8'),
    )
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const files = (await collectContextFiles(contextDir, '', ignore)).sort()

  const dockerfileRel = path.relative(contextDir, dockerfilePath)
  if (dockerfileRel.startsWith('..') || path.isAbsolute(dockerfileRel)) {
    throw new Error(
      `dockerfile ${dockerfilePath} is outside its build context ${contextDir}`,
    )
  }
  if (!files.includes(dockerfileRel)) files.push(dockerfileRel)

  let totalBytes = 0
  for (const rel of files) {
    totalBytes += (await fs.stat(path.join(contextDir, rel))).size
  }
  if (totalBytes > BUILDER_CONTEXT_MAX_BYTES) {
    throw new Error(
      `build context ${contextDir} is ${Math.round(totalBytes / 1024 ** 2)}MB `
      + `(limit ${BUILDER_CONTEXT_MAX_BYTES / 1024 ** 2}MB). Add a `
      + '.containerignore excluding large dirs the Dockerfile does not COPY.',
    )
  }
  return { files, dockerfileRel, totalBytes }
}

interface PodExecOptions {
  /** stdin, e.g. the context tar. */
  input?: NodeJS.ReadableStream
  onLog?: (line: string) => void
  logPrefix: string
  /** Idle timeout (see container/streaming-proc.ts). */
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

/**
 * Stream the context files into the pod as a tar over exec stdin, into a
 * freshly wiped BUILDER_CONTEXT_DIR (a reused pod still has the previous
 * layer's context).
 */
async function streamContextToPod(
  podName: string,
  contextDir: string,
  files: string[],
  opts: { onLog?: (line: string) => void; logPrefix: string },
): Promise<void> {
  // The file list goes in a temp file: it can exceed argv limits, and
  // stdin carries the archive.
  const listDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-build-ctx-'))
  const listFile = path.join(listDir, 'files.txt')
  await fs.writeFile(listFile, files.map((f) => `${f}\n`).join(''))
  try {
    const tar = spawn('tar', ['-cf', '-', '-T', listFile], {
      cwd: contextDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tarStderr: string[] = []
    pipeToServerLog(tar.stderr, opts.logPrefix, (l) => tarStderr.push(l))
    tar.stdout.on('error', () => {}) // EPIPE when the exec side dies first
    const tarExit = new Promise<void>((resolve, reject) => {
      tar.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar exited with code ${code}: ${tarStderr.join('\n')}`))
      })
      tar.on('error', reject)
    })
    const extract = `rm -rf ${BUILDER_CONTEXT_DIR} && mkdir -p ${BUILDER_CONTEXT_DIR} `
      + `&& tar -xf - -C ${BUILDER_CONTEXT_DIR}`
    await Promise.all([
      execInBuilderPod(podName, ['sh', '-c', extract], {
        input: tar.stdout,
        onLog: opts.onLog,
        logPrefix: opts.logPrefix,
        idleTimeoutMs: BUILDER_CONTEXT_IDLE_TIMEOUT_MS,
      }),
      tarExit,
    ])
  } finally {
    await fs.rm(listDir, { recursive: true, force: true })
  }
}

/** Builder egress: anywhere but what `wideEgress` cuts out, each of which
 *  would give a `RUN` step the server's or a node's authority. The
 *  world-deny policy excludes builders, so this is the policy that applies
 *  to them. */
function buildBuilderEgressNetworkPolicyManifest(nodeCidrs: string[]): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: 'yaac-builder-egress',
      namespace: k8sNamespace(),
    },
    spec: {
      podSelector: { matchLabels: { [LABEL_ROLE]: ROLE_BUILDER } },
      policyTypes: ['Egress'],
      egress: wideEgress(nodeCidrs),
    },
  }
}

/** Apply the builder-role admission guard and egress policy. */
async function ensureBuilderNetworkPolicies(): Promise<void> {
  await ensureBuilderRoleGuard()
  await applyObject(buildBuilderEgressNetworkPolicyManifest(await nodeIpBlocks()))
}

/**
 * One builder pod, created on first `acquire` and shared by the untrusted
 * layers of one `ensureImage` call, which calls `release` to delete it.
 */
export class BuilderPodLease {
  private podName: string | null = null
  private acquiring: Promise<string> | null = null

  async acquire(seedTag: string): Promise<string> {
    if (!this.acquiring) {
      this.acquiring = this.provision(seedTag).catch((err: unknown) => {
        this.acquiring = null // a later layer may retry provisioning
        throw err
      })
    }
    return this.acquiring
  }

  private async provision(seedTag: string): Promise<string> {
    try {
      await ensureKubernetes()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        'Dockerfile.yaac / Dockerfile.user layers build in sandboxed cluster '
        + 'pods, which needs a healthy cluster. '
        + `Run \`yaac cluster check\`.\n${detail}`,
      )
    }
    // Fail here, not inside the pod, if the registry is not up.
    await ensureMainRegistry()
    const imageRef = await ensureBuilderImage()
    await ensureBuilderNetworkPolicies()

    const name = builderPodName(seedTag)
    serverLog(`[builder] creating builder pod ${name}`)
    await applyObject(buildBuilderPodManifest(name, imageRef))
    try {
      // `kubectl wait`: the substrate's watch-based wait is for Job pods.
      await execFileAsync('kubectl', [
        'wait', '--for=condition=Ready', `pod/${name}`, '-n', k8sNamespace(),
        `--timeout=${Math.floor(BUILDER_READY_TIMEOUT_MS / 1000)}s`,
      ], { timeout: BUILDER_READY_TIMEOUT_MS + 15_000 })
      await execInBuilderPod(name, ['sh', '-c', builderStorageConfScript()], {
        logPrefix: `[builder ${name}] `,
        idleTimeoutMs: 30_000,
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

  /** Delete the pod. Best-effort: activeDeadlineSeconds bounds a leak, and
   *  the next server's start deletes it. */
  async release(): Promise<void> {
    const pending = this.acquiring
    this.acquiring = null
    const name = this.podName ?? (pending ? await pending.catch(() => null) : null)
    this.podName = null
    if (name) await deleteBuilderPod(name)
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
  const pod = await ctx.lease.acquire(layer.tag)
  const clusterHost = registryHost()
  const logPrefix = `[build ${layer.tag}] `
  const execOpts = { onLog: ctx.onLog, logPrefix }
  try {
    await runLayerBuild(pod, layer, ctx, clusterHost, execOpts)
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
  clusterHost: string,
  execOpts: { onLog?: (line: string) => void; logPrefix: string },
): Promise<void> {
  const parentTag = layer.buildArgs?.BASE_IMAGE
  if (parentTag) {
    await execInBuilderPod(
      pod,
      ['sh', '-c', builderParentPullScript(parentTag, clusterHost)],
      { ...execOpts, idleTimeoutMs: BUILDER_PULL_IDLE_TIMEOUT_MS },
    )
  }

  const plan = await planBuildContext(layer.context, layer.dockerfile)
  await streamContextToPod(pod, layer.context, plan.files, execOpts)

  // Sent over stdin, not argv. Each layer gets a fresh grant, valid for
  // the pod's lifetime.
  const authFile = await registryAuthFile(
    clusterHost,
    builderGrantRepos(layer, ctx.projectId),
    BUILDER_ACTIVE_DEADLINE_SECONDS + 60,
  )
  await execInBuilderPod(
    pod,
    ['sh', '-c', `umask 077 && cat > ${BUILDER_AUTHFILE}`],
    { ...execOpts, input: Readable.from([authFile]), idleTimeoutMs: BUILDER_CONTEXT_IDLE_TIMEOUT_MS },
  )

  await execInBuilderPod(
    pod,
    ['podman', ...builderBuildArgs(layer, {
      dockerfileRel: plan.dockerfileRel,
      clusterHost,
      cacheRepo: buildCacheRepo(ctx.projectId),
    })],
    { ...execOpts, idleTimeoutMs: BUILDER_BUILD_IDLE_TIMEOUT_MS },
  )

  // Parent blobs came from this registry, so podman cross-repo mounts
  // them instead of re-uploading. No HEAD check: the build only ran because
  // the tag was missing.
  await execInBuilderPod(
    pod,
    [
      'podman', 'push', '--tls-verify=false', '--authfile', BUILDER_AUTHFILE,
      layer.tag, `${clusterHost}/${layer.tag}`,
    ],
    { ...execOpts, idleTimeoutMs: BUILDER_PUSH_IDLE_TIMEOUT_MS },
  )
}

/**
 * Delete every builder pod of this install, at server start. Only one
 * server runs per install (its Deployment is `replicas: 1` with `Recreate`,
 * so the old pod is gone before this one starts), so any builder pod then
 * is a leak from the last one, and its memory reservation could block
 * every build after a restart.
 * During the server's life `release` deletes pods inline, and a leaked one
 * is bounded by its activeDeadlineSeconds.
 */
export async function deleteLeakedBuilderPods(): Promise<void> {
  await deleteObjects('v1', 'Pod', {
    namespace: k8sNamespace(),
    labelSelector: `${LABEL_ROLE}=${ROLE_BUILDER},${LABEL_DATA_DIR_HASH}=${dataDirHash()}`,
  })
}
