/**
 * Ephemeral runsc builder pods — the `cluster-pod` build engine
 * (docs/trust-split-builds-plan.md).
 *
 * Untrusted Dockerfiles (`Dockerfile.yaac` / `Dockerfile.user` — user- and
 * agent-editable) never execute on the host podman engine. Each build
 * request gets a throwaway gVisor pod running the pinned podman-stable
 * image (shared with the salvage writer); adjacent untrusted layers in one
 * chain reuse the pod via a BuilderPodLease. Per layer the flow is:
 *
 *   1. bootstrap /etc/containers/storage.conf (native overlay on the
 *      sentry tmpfs graphroot — the stock image forces fuse-overlayfs,
 *      which is broken under runsc),
 *   2. materialize the parent: pull `<registry-svc>/P` + retag to the bare
 *      tag so `--build-arg BASE_IMAGE=P` matches host builds,
 *   3. stream the build context in as a tar over `kubectl exec -i`,
 *      honoring `.containerignore` exactly like `contextHash()`,
 *   4. `podman build --isolation chroot` with registry step cache
 *      (`--cache-from`/`--cache-to`, per-project repo),
 *   5. delta push the product (parent blobs cross-repo-mount, never
 *      re-upload),
 *   6. delete the pod (the reap sweep catches leaks).
 *
 * The registry is the only image bus: parents come from it, products and
 * per-step cache images go back to it, and the host store never sees these
 * tags.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  ensureKubernetes,
} from '#platform/k8s/kubectl'
import { LABEL_DATA_DIR_HASH } from '#platform/k8s/pods'
import {
  LABEL_ROLE,
  ROLE_BUILDER,
  EGRESS_WORLD_DENY_NAME,
  buildEgressWorldDenyCiliumPolicyManifest,
  buildBuilderRoleGuardPolicyManifest,
  buildBuilderRoleGuardBindingManifest,
} from '#features/cluster/bootstrap'
import { vapAvailable } from '#features/cluster/vcluster'
import { RUNTIME_CLASS_GVISOR } from '#platform/k8s/gvisor'
import {
  NESTED_ENGINE_CAPS,
  NESTED_GRAPHROOT_PATH,
  NESTED_GRAPHROOT_VOLUME,
  graphrootMountAnnotations,
} from '#platform/k8s/pod-spec'
import { ensureRegistryClusterService, registryClusterHost } from '#features/cluster/registry-service'
import { ensureSalvageWriterImage } from '#features/images/image-promoter'
import {
  parseContainerIgnore,
  collectContextFiles,
  stringHash,
  type ImageLayer,
} from '#features/images/image-builder'
import type { EngineBuildContext } from '#features/images/build-engine'
import { serverLog, pipeToServerLog } from '#log'

/** `yaac.role` value on builder pods (reaped by reconcileBuilderPodGc). */
export { ROLE_BUILDER }

/**
 * Sentry tmpfs cap for the builder graphroot: parent chain (~5GB for the
 * tools chain) + build products + per-step cache images. Larger than the
 * session pods' 8Gi because a build holds parent AND product layers
 * simultaneously. Pure scratch — dies with the pod.
 */
export const BUILDER_GRAPHROOT_TMPFS_BYTES = 16 * 1024 ** 3

/** emptyDir sizeLimit: sentry cap + slack (same rationale as sessions —
 *  eviction must stay unreachable behind the sentry's ENOSPC). */
export const BUILDER_GRAPHROOT_SIZELIMIT_BYTES = BUILDER_GRAPHROOT_TMPFS_BYTES + 1024 ** 3

/** Pod memory limit. Layer data lives in the disk-backed graphroot, not
 *  memory, so this bounds build processes only. */
export const BUILDER_MEMORY_LIMIT_BYTES = 8 * 1024 ** 3

/**
 * Whole-pod bound, above the sum of the per-phase budgets for a two-layer
 * chain (ready 60 + pull 180 + 2×(build 600 + push 120) = 1680s) — the
 * last-resort stop for a pod the server crashed away from.
 */
export const BUILDER_ACTIVE_DEADLINE_SECONDS = 1800

/** Per-phase exec budgets (ms). */
export const BUILDER_READY_TIMEOUT_MS = 60_000
export const BUILDER_PULL_TIMEOUT_MS = 180_000
export const BUILDER_BUILD_TIMEOUT_MS = 600_000
export const BUILDER_PUSH_TIMEOUT_MS = 120_000
export const BUILDER_CONTEXT_TIMEOUT_MS = 120_000

/**
 * Sanity cap on the streamed build context. Contexts are dedicated build
 * dirs (Dockerfile + user-managed support files); the build-files API
 * mirrors this cap at upload time so a folder that grows past it fails
 * there rather than at the next build.
 */
export const BUILDER_CONTEXT_MAX_BYTES = 512 * 1024 ** 2

/**
 * `--cache-ttl` bound on registry step-cache reads: entries older than
 * this are treated as misses, so poisoned or stale cache ages out and the
 * cache repos' useful window is bounded for GC sizing.
 */
export const BUILD_CACHE_TTL = '168h'

/** In-pod path the build context is extracted to. */
export const BUILDER_CONTEXT_DIR = '/tmp/yaac-build-ctx'

/**
 * Per-project registry repo for `--cache-from`/`--cache-to` step-cache
 * images. Per PROJECT on purpose: cache entries are consumed by key with
 * no provenance check, so a hostile build can poison future cache hits —
 * a per-project repo confines that to the project whose image the
 * attacker already controls. `Dockerfile.user` layers cache into the repo
 * of the project being built.
 */
export function buildCacheRepo(projectSlug: string): string {
  const slug = projectSlug.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  return `yaac-buildcache-${slug}`
}

/** Builder pod name: hash of the first layer tag + entropy, so concurrent
 *  builds of distinct chains never collide and names stay label-safe. */
export function builderPodName(seedTag: string): string {
  return `yaac-builder-${stringHash(seedTag).slice(0, 8)}-${crypto.randomBytes(2).toString('hex')}`
}

/**
 * Builder pod manifest. gVisor (plain `gvisor` handler — chroot builds
 * need no raw sockets), the nested-engine cap set (no host authority under
 * the sentry), no SA token, seccomp RuntimeDefault, and the graphroot on a
 * disk-backed sentry-internal tmpfs via the `dev.gvisor.spec.mount.*`
 * annotations (spike-verified under the plain handler). Parked on `sleep`;
 * the server drives it with `kubectl exec` so build logs stream into the
 * build-tracking registry exactly like a host build's piped output.
 */
export function buildBuilderPodManifest(name: string, imageRef: string): Record<string, unknown> {
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
      annotations: graphrootMountAnnotations(BUILDER_GRAPHROOT_TMPFS_BYTES),
    },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: BUILDER_ACTIVE_DEADLINE_SECONDS,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      runtimeClassName: RUNTIME_CLASS_GVISOR,
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
 * First-exec bootstrap: replace the stock image's storage.conf. It forces
 * `mount_program = fuse-overlayfs`, which is broken under runsc — native
 * overlay on the sentry tmpfs graphroot is the spike-validated
 * configuration. `pull_options` keeps partial-image (zstd:chunked) pull
 * support enabled, matching the stock file.
 */
export function builderStorageConfScript(): string {
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
 * Materialize the parent image in the pod's store: `FROM ${BASE_IMAGE}`
 * resolves locally, so this leg cannot be removed by step cache — only
 * skipped when the pod already holds the tag (pod reuse: the second
 * untrusted layer's parent is the first layer's freshly built product).
 * The registry ref is retagged to the bare tag so build args match host
 * builds byte-for-byte.
 */
export function builderParentPullScript(parentTag: string, clusterHost: string): string {
  const remote = `${clusterHost}/${parentTag}`
  return [
    'set -eu',
    `if podman image exists ${parentTag}; then exit 0; fi`,
    `podman pull --tls-verify=false ${remote}`,
    `podman tag ${remote} ${parentTag}`,
  ].join('\n')
}

/** `podman build` argv for the in-pod build (everything after `podman`). */
export function builderBuildArgs(
  layer: ImageLayer,
  opts: {
    dockerfileRel: string
    clusterHost: string
    cacheRepo: string
    noCache: boolean
  },
): string[] {
  const args = [
    'build',
    // chroot isolation: RUN steps execute in a chroot inside the sandbox
    // instead of a nested OCI runtime — the spike-validated mode.
    '--isolation', 'chroot',
    '--tls-verify=false',
    '-t', layer.tag,
    '-f', `${BUILDER_CONTEXT_DIR}/${opts.dockerfileRel}`,
  ]
  if (opts.noCache) {
    args.push('--no-cache')
  } else {
    // Registry step cache: an edited Dockerfile re-runs only its changed
    // steps in any fresh pod (validated: all-hit rebuild ~1.3s in a wiped
    // store). Reads bounded by BUILD_CACHE_TTL.
    const cacheRef = `${opts.clusterHost}/${opts.cacheRepo}`
    args.push(
      '--cache-from', cacheRef,
      '--cache-to', cacheRef,
      '--cache-ttl', BUILD_CACHE_TTL,
    )
  }
  for (const [key, value] of Object.entries(layer.buildArgs ?? {})) {
    args.push('--build-arg', `${key}=${value}`)
  }
  args.push(BUILDER_CONTEXT_DIR)
  return args
}

export interface BuildContextPlan {
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
export async function planBuildContext(
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
    // Never true for the untrusted layers resolveImageChain emits (their
    // dockerfile always lives in the context dir); guard against misuse.
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
  input?: string | NodeJS.ReadableStream
  onLog?: (line: string) => void
  logPrefix: string
  timeoutMs: number
}

/**
 * `kubectl exec -i` into the builder pod, streaming stdout/stderr lines to
 * the server log and the caller (the build-tracking registry). Uses spawn
 * (not the buffered kubectl helpers): build output is unbounded and must
 * stream.
 */
async function execInBuilderPod(
  podName: string,
  command: string[],
  opts: PodExecOptions,
): Promise<void> {
  const args = ['exec', '-i', '-n', k8sNamespace(), `pod/${podName}`, '--', ...command]
  await new Promise<void>((resolve, reject) => {
    const child = spawn('kubectl', args, {
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: opts.timeoutMs,
    })
    const tail: string[] = []
    const onLine = (line: string): void => {
      tail.push(line)
      if (tail.length > 20) tail.shift()
      opts.onLog?.(line)
    }
    pipeToServerLog(child.stdout, opts.logPrefix, onLine)
    pipeToServerLog(child.stderr, opts.logPrefix, onLine)
    if (opts.input !== undefined && child.stdin) {
      // The remote side can exit before consuming all input (a failed
      // extract) — swallow the EPIPE; the exit code carries the verdict.
      child.stdin.on('error', () => {})
      if (typeof opts.input === 'string') child.stdin.end(opts.input)
      else opts.input.pipe(child.stdin)
    }
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        reject(new Error(
          `builder exec [${command.join(' ').slice(0, 120)}] exited with code ${code}`
          + (tail.length ? `:\n${tail.join('\n')}` : ''),
        ))
      }
    })
    child.on('error', reject)
  })
}

/**
 * Stream the planned context files into the pod as a tar over exec stdin,
 * extracting to BUILDER_CONTEXT_DIR (wiped first — pod reuse must not leak
 * a previous layer's context into this build).
 */
async function streamContextToPod(
  podName: string,
  contextDir: string,
  files: string[],
  opts: { onLog?: (line: string) => void; logPrefix: string },
): Promise<void> {
  // File list via a temp file (not argv: data-dir contexts can exceed argv
  // limits; not stdin: stdin carries the archive). tar runs with
  // cwd=context so `-T` names resolve relative on both GNU and BSD tar.
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
        timeoutMs: BUILDER_CONTEXT_TIMEOUT_MS,
      }),
      tarExit,
    ])
  } finally {
    await fs.rm(listDir, { recursive: true, force: true })
  }
}

/** Builder egress: explicit allow-all for role=builder pods. The real
 *  gate is the world-deny CNP's builder exclusion; this keeps the intent
 *  declared even if a future default-deny NetworkPolicy lands in the
 *  namespace. */
export function buildBuilderEgressNetworkPolicyManifest(): Record<string, unknown> {
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
      egress: [{}],
    },
  }
}

/**
 * Cluster-wide admission guard reserving the `yaac.role=builder` label:
 * no ServiceAccount (the only identity untrusted code can hold — e.g. a
 * vcluster syncer materializing a session's pods) may create or update a
 * pod carrying it, and carriers must run under the gvisor RuntimeClass.
 * Fail-closed: the label excludes its pods from the world-deny egress
 * policy, so builders must not run on a cluster that cannot enforce the
 * reservation. Applied idempotently here and by `yaac cluster setup`.
 */
export async function ensureBuilderRoleGuard(): Promise<void> {
  if (!await vapAvailable()) {
    throw new Error(
      'sandboxed image builds need the ValidatingAdmissionPolicy API to '
      + `reserve the ${LABEL_ROLE}=${ROLE_BUILDER} pod label (kubernetes `
      + '>= 1.30). Recreate the cluster with `yaac cluster setup`.',
    )
  }
  await kubectlApply(buildBuilderRoleGuardPolicyManifest())
  await kubectlApply(buildBuilderRoleGuardBindingManifest())
}

/**
 * Apply the builder-role admission guard and egress policy, and refresh
 * the world-deny CNP when it already exists in this namespace — an older
 * server may have written it without the builder exclusion, and a Cilium
 * deny cannot be overridden by any allow. Only refreshed (never
 * introduced): namespaces without the deny keep their existing posture.
 */
async function ensureBuilderNetworkPolicies(): Promise<void> {
  await ensureBuilderRoleGuard()
  await kubectlApply(buildBuilderEgressNetworkPolicyManifest())
  const existing = await kubectlGetJson<Record<string, unknown>>([
    'get', 'ciliumnetworkpolicy', EGRESS_WORLD_DENY_NAME, '-n', k8sNamespace(),
  ]).catch(() => null)
  if (existing) await kubectlApply(buildEgressWorldDenyCiliumPolicyManifest())
}

/**
 * One builder pod, lazily created and shared by the untrusted layers of a
 * single build request. `acquire` is idempotent (first caller creates the
 * pod, later callers reuse it); `release` deletes it. The creator
 * (ensureImage / rebuildProjectImage) owns release; a coordinator joiner
 * shares only the build promise, never the lease.
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
    const imageRef = await ensureSalvageWriterImage()
    await ensureRegistryClusterService()
    await ensureBuilderNetworkPolicies()

    const name = builderPodName(seedTag)
    serverLog(`[builder] creating builder pod ${name}`)
    await kubectlApply(buildBuilderPodManifest(name, imageRef))
    try {
      await kubectlWithRetry([
        'wait', '--for=condition=Ready', `pod/${name}`, '-n', k8sNamespace(),
        `--timeout=${Math.floor(BUILDER_READY_TIMEOUT_MS / 1000)}s`,
      ], { timeout: BUILDER_READY_TIMEOUT_MS + 15_000, maxAttempts: 1 })
      await execInBuilderPod(name, ['sh', '-c', builderStorageConfScript()], {
        logPrefix: `[builder ${name}] `,
        timeoutMs: 30_000,
      })
    } catch (err) {
      await deleteBuilderPod(name)
      throw err
    }
    this.podName = name
    return name
  }

  /** Delete the pod (best-effort — the label sweep catches leaks). */
  async release(): Promise<void> {
    const pending = this.acquiring
    this.acquiring = null
    const name = this.podName ?? (pending ? await pending.catch(() => null) : null)
    this.podName = null
    if (name) await deleteBuilderPod(name)
  }
}

async function deleteBuilderPod(name: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'pod', name, '-n', k8sNamespace(),
    '--ignore-not-found', '--wait=false',
  ], { maxAttempts: 2 }).catch((err: unknown) => {
    serverLog(`[builder] failed to delete pod ${name}: ${String(err)}`)
  })
}

/**
 * The cluster-pod engine's build: acquire the lease's pod (creating it on
 * first use), materialize the parent, stream the context, build with the
 * registry step cache, and push the product. When the caller supplied no
 * lease (direct engine use), a private one is created and released.
 */
export async function buildLayerInPod(
  layer: ImageLayer,
  ctx: EngineBuildContext,
): Promise<void> {
  const lease = ctx.lease ?? new BuilderPodLease()
  const owned = !ctx.lease
  try {
    const pod = await lease.acquire(layer.tag)
    const clusterHost = registryClusterHost()
    const logPrefix = `[build ${layer.tag}] `
    const execOpts = { onLog: ctx.onLog, logPrefix }

    const parentTag = layer.buildArgs?.BASE_IMAGE
    if (parentTag) {
      await execInBuilderPod(
        pod,
        ['sh', '-c', builderParentPullScript(parentTag, clusterHost)],
        { ...execOpts, timeoutMs: BUILDER_PULL_TIMEOUT_MS },
      )
    }

    const plan = await planBuildContext(layer.context, layer.dockerfile)
    await streamContextToPod(pod, layer.context, plan.files, execOpts)

    await execInBuilderPod(
      pod,
      ['podman', ...builderBuildArgs(layer, {
        dockerfileRel: plan.dockerfileRel,
        clusterHost,
        cacheRepo: buildCacheRepo(ctx.projectSlug),
        noCache: ctx.noCache ?? false,
      })],
      { ...execOpts, timeoutMs: BUILDER_BUILD_TIMEOUT_MS },
    )

    // Delta push: parent blobs were just pulled from this registry, so
    // podman's blob-info cache cross-repo-mounts them (~1.2s measured).
    // Always pushes (no HEAD skip) — a --no-cache rebuild must overwrite
    // the unchanged content-hash tag with fresh bytes.
    await execInBuilderPod(
      pod,
      ['podman', 'push', '--tls-verify=false', layer.tag, `${clusterHost}/${layer.tag}`],
      { ...execOpts, timeoutMs: BUILDER_PUSH_TIMEOUT_MS },
    )
  } finally {
    if (owned) await lease.release()
  }
}

/** Age past which a builder pod is unconditionally a leak: comfortably
 *  above BUILDER_ACTIVE_DEADLINE_SECONDS, so no live build can reach it. */
export const BUILDER_REAP_AGE_MS = 45 * 60_000

const BUILDER_REAP_INTERVAL_MS = 10 * 60_000
let lastReapMs = 0

/** Test hook: reset the reap throttle. */
export function _resetBuilderReapForTests(): void {
  lastReapMs = 0
}

/**
 * Background sweep for leaked builder pods (server crashed mid-build):
 * deletes this install's role=builder pods that are terminal (the active
 * deadline already stopped them) or older than any live build can be.
 * Internally throttled; the normal path deletes pods inline in `release`.
 */
export async function reconcileBuilderPodGc(now = Date.now()): Promise<void> {
  if (now - lastReapMs < BUILDER_REAP_INTERVAL_MS) return
  lastReapMs = now
  const selector = `${LABEL_ROLE}=${ROLE_BUILDER},${LABEL_DATA_DIR_HASH}=${dataDirHash()}`
  const list = await kubectlGetJson<{
    items?: Array<{
      metadata?: { name?: string; creationTimestamp?: string }
      status?: { phase?: string }
    }>
  }>(['get', 'pods', '-n', k8sNamespace(), '-l', selector]).catch(() => null)
  for (const pod of list?.items ?? []) {
    const name = pod.metadata?.name
    if (!name) continue
    const phase = pod.status?.phase ?? 'Unknown'
    const created = Date.parse(pod.metadata?.creationTimestamp ?? '')
    const expired = Number.isFinite(created) && now - created > BUILDER_REAP_AGE_MS
    if (phase !== 'Succeeded' && phase !== 'Failed' && !expired) continue
    serverLog(`[builder] reaping stale builder pod ${name} (phase ${phase})`)
    await deleteBuilderPod(name)
  }
}
