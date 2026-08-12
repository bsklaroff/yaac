/**
 * Ephemeral runsc builder pods — the `cluster-pod` build engine
 * (docs/trust-split-builds.md).
 *
 * Untrusted Dockerfiles (`Dockerfile.yaac` / `Dockerfile.user` — user- and
 * agent-editable) never execute on the host podman engine. Each build
 * request gets a throwaway gVisor pod running the pinned podman-stable
 * image; adjacent untrusted layers in one chain reuse the pod via a
 * BuilderPodLease. Per layer the flow is:
 *
 *   1. bootstrap /etc/containers/storage.conf (native overlay on the
 *      sentry tmpfs graphroot — the stock image forces fuse-overlayfs,
 *      which is broken under runsc),
 *   2. materialize the parent: pull `<registry-host>/P` + retag to the bare
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
  imageExists,
  pushImageToRegistry,
  registryHasTag,
  registryHost,
  registryRef,
} from '#runtime/k8s/container'
import { BUILDER_CONTEXT_MAX_BYTES, collectContextFiles, parseContainerIgnore } from '#lib/build-context'
import { testEnv } from '@yaac/shared/env'
import {
  EGRESS_WORLD_DENY_NAME,
  LABEL_DATA_DIR_HASH,
  LABEL_ROLE,
  NESTED_ENGINE_CAPS,
  NESTED_GRAPHROOT_PATH,
  NESTED_GRAPHROOT_VOLUME,
  PRIORITY_CLASS_BUILDER,
  ROLE_BUILDER,
  RUNTIME_CLASS_GVISOR,
  dataDirHash,
  ensureKubernetes,
  execFileAsync,
  graphrootMountAnnotations,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#runtime/k8s/substrate'
import {
  buildEgressWorldDenyNpManifest,
  ensureBuilderRoleGuard,
  ensureMainRegistry,
} from '#runtime/k8s/cluster'
import { runStreamingProcess } from '#runtime/k8s/container'
import type { EngineBuildContext } from './build-engine'
import { serverLog, pipeToServerLog } from '#log'
import { stringHash, type ImageLayer } from '#runtime/k8s/image-engine'

/**
 * Digest-pinned upstream image the builder pods run — podman + coreutils,
 * mirrored into the local registry like the vcluster image set (the digest
 * IS the pin; no content-hash tag). Pinned near the worktree engines'
 * podman major so store metadata stays compatible. Never the worktree's own
 * image: its binaries are user-customizable and must not run yaac-driven
 * builds.
 */
export const BUILDER_UPSTREAM_IMAGE =
  'quay.io/podman/stable@sha256:25d49cf990843962043942db172c7ef5c6f85012384aada7976aec65906ae209'
export const BUILDER_LOCAL_TAG = 'podman-stable:v5.5'

/**
 * Sentry tmpfs cap for the builder graphroot: parent chain (~5GB for the
 * tools chain) + build products + per-step cache images. Larger than the
 * worktree pods' 8Gi because a build holds parent AND product layers
 * simultaneously. Pure scratch — dies with the pod.
 */
export const BUILDER_GRAPHROOT_TMPFS_BYTES = 16 * 1024 ** 3

/** emptyDir sizeLimit: sentry cap + slack (same rationale as worktrees —
 *  eviction must stay unreachable behind the sentry's ENOSPC). */
export const BUILDER_GRAPHROOT_SIZELIMIT_BYTES = BUILDER_GRAPHROOT_TMPFS_BYTES + 1024 ** 3

/** Pod memory limit. Layer data lives in the disk-backed graphroot, not
 *  memory, so this bounds build processes only. */
export const BUILDER_MEMORY_LIMIT_BYTES = 8 * 1024 ** 3

/**
 * Scheduler reservation for a builder, well under the limit above. Explicit
 * because kubernetes defaults an omitted request UP TO the limit: a
 * limits-only builder reserved the whole 8Gi ceiling, which on a
 * request-saturated node is 8 worktrees' worth of memory that one routine
 * build would have to displace to schedule. Compression is the same bet
 * worktrees make — a build's steady state is well below its peak, and the
 * peak is still allowed by the limit.
 */
export const BUILDER_MEMORY_REQUEST_BYTES = 2 * 1024 ** 3

/** cpu floor, no ceiling — same reasoning as worktree pods (a CFS quota
 *  would only make builds slower on an idle node). Builds are burstier
 *  than a worktree, hence the larger share. */
export const BUILDER_CPU_REQUEST_MILLIS = 500

/**
 * Whole-pod bound, and with idle per-phase budgets below it the only cap on
 * how long a build may run. It stops two things: a pod the server crashed
 * away from, and a build that is wedged but chatty — one that keeps printing
 * and so never trips an idle budget.
 *
 * Four hours is a chosen "hours, not minutes" value, not derived from
 * anything: far above any honest chain (a cold multi-layer chain compiling a
 * toolchain), far below never. Raising it costs what the reap comment below
 * describes — a stuck builder parks its memory reservation for that long,
 * and two builders do not fit on a typical node — which is bounded by
 * `release()` deleting the pod inline on failure and by the reaper deleting
 * every pod that predates this server process.
 */
export const BUILDER_ACTIVE_DEADLINE_SECONDS = 4 * 3600

/**
 * Per-phase exec budgets (ms). Every one is an *idle* budget — time since
 * the step last produced output (see streaming-proc.ts) — not a cap on the
 * step's duration. Only the pod's readiness wait is a true total: nothing
 * streams while a pod schedules.
 */
export const BUILDER_READY_TIMEOUT_MS = 60_000
export const BUILDER_PULL_IDLE_TIMEOUT_MS = 180_000
export const BUILDER_BUILD_IDLE_TIMEOUT_MS = 600_000
export const BUILDER_PUSH_IDLE_TIMEOUT_MS = 120_000
export const BUILDER_CONTEXT_IDLE_TIMEOUT_MS = 120_000

/** Hard cap on any one exec: the pod is gone by then, so kubectl is too. */
const BUILDER_EXEC_TOTAL_TIMEOUT_MS = (BUILDER_ACTIVE_DEADLINE_SECONDS + 300) * 1000

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
 *
 * The confinement is over WHERE THIS BUILD READS AND WRITES, not a
 * boundary: the registry is unauthenticated with no path ACLs, so a
 * hostile RUN step can push to another project's cache repo by hand. See
 * the open risk in docs/trust-split-builds.md.
 */
export function buildCacheRepo(projectSlug: string): string {
  const slug = projectSlug.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  return `yaac-buildcache-${slug}`
}

/** Ensure the pinned builder image is present in the local registry,
 *  mirroring it from upstream on first use (same convention as
 *  ensureVclusterImages — the digest is the pin). */
export async function ensureBuilderImage(
  requirePrebuilt = testEnv.requirePrebuiltImages,
): Promise<string> {
  if (!await registryHasTag(BUILDER_LOCAL_TAG)) {
    if (!await imageExists(BUILDER_LOCAL_TAG)) {
      if (requirePrebuilt) {
        throw new Error(
          `builder image ${BUILDER_LOCAL_TAG} is missing. `
          + 'Restart the test run so the global setup can mirror it.',
        )
      }
      await execFileAsync('podman', ['pull', BUILDER_UPSTREAM_IMAGE], { timeout: 600_000 })
      await execFileAsync('podman', ['tag', BUILDER_UPSTREAM_IMAGE, BUILDER_LOCAL_TAG])
    }
    await pushImageToRegistry(BUILDER_LOCAL_TAG)
  }
  return registryRef(BUILDER_LOCAL_TAG)
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
      // Above worktrees (a build one is waiting on should outlive it under
      // node pressure), but the builder class forbids preemption: a build
      // that waits for room costs a worktree create some latency, where a
      // preempted worktree pod is gone for good (backoffLimit 0).
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

/**
 * `podman build` argv for the in-pod build (everything after `podman`).
 *
 * There is no --no-cache variant: the only forced rebuild is `yaac project
 * rebuild`, which forces exactly the tools layer, and tools is always
 * host-built. An in-pod layer therefore always keeps its step cache. If a
 * forced in-pod rebuild is ever wanted, add the flag here and thread it
 * from rebuildProjectImage — the absence is deliberate, not an oversight.
 */
export function builderBuildArgs(
  layer: ImageLayer,
  opts: {
    dockerfileRel: string
    clusterHost: string
    cacheRepo: string
  },
): string[] {
  // Registry step cache: an edited Dockerfile re-runs only its changed
  // steps in any fresh pod (validated: all-hit rebuild ~1.3s in a wiped
  // store). Reads bounded by BUILD_CACHE_TTL.
  const cacheRef = `${opts.clusterHost}/${opts.cacheRepo}`
  const args = [
    'build',
    // chroot isolation: RUN steps execute in a chroot inside the sandbox
    // instead of a nested OCI runtime — the spike-validated mode.
    '--isolation', 'chroot',
    '--tls-verify=false',
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
  /** Stream only — the one input this takes is the context tar. */
  input?: NodeJS.ReadableStream
  onLog?: (line: string) => void
  logPrefix: string
  /** Silence, not duration, that ends the step (see streaming-proc.ts). */
  idleTimeoutMs: number
}

/**
 * `kubectl exec -i` into the builder pod, streaming stdout/stderr lines to
 * the server log and the caller (the build-tracking registry).
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
    // No exec can outlive the pod it runs in, so the pod's own deadline is
    // this one's hard cap.
    timeoutMs: BUILDER_EXEC_TOTAL_TIMEOUT_MS,
    label: `builder exec [${command.join(' ').slice(0, 120)}]`,
    tailLines: 20,
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
        idleTimeoutMs: BUILDER_CONTEXT_IDLE_TIMEOUT_MS,
      }),
      tarExit,
    ])
  } finally {
    await fs.rm(listDir, { recursive: true, force: true })
  }
}

/** Builder egress: explicit allow-all for role=builder pods. The real
 *  gate is the world-deny policy's builder exclusion; this keeps the intent
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
 * Apply the builder-role admission guard and egress policy, and refresh
 * the world-deny policy when it already exists in this namespace — an
 * older server may have written it without the builder exclusion, which
 * would leave builder pods selected by a default-deny they need to be
 * outside of. Only refreshed (never introduced): namespaces without it
 * keep their existing posture.
 */
async function ensureBuilderNetworkPolicies(): Promise<void> {
  await ensureBuilderRoleGuard()
  await kubectlApply(buildBuilderEgressNetworkPolicyManifest())
  const existing = await kubectlGetJson<Record<string, unknown>>([
    'get', 'networkpolicy', EGRESS_WORLD_DENY_NAME, '-n', k8sNamespace(),
  ]).catch(() => null)
  if (existing) await kubectlApply(buildEgressWorldDenyNpManifest())
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
    // The registry is what a builder pod pulls its parent from and pushes
    // its product to, so an install whose registry never came up must fail
    // here rather than inside the pod.
    await ensureMainRegistry()
    const imageRef = await ensureBuilderImage()
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

  /** Delete the pod (best-effort — the label sweep catches leaks). */
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
 * Why a builder pod never reached Ready, in one line, from its status.
 * `kubectl wait` reports only that it timed out, which reads as "the build
 * is broken" for the two failures that are really about the node: the pod
 * never scheduled (another builder's 8 GiB reservation is the usual reason)
 * or its image never pulled. Returns null when the status says nothing
 * useful — the caller then keeps the bare timeout.
 */
export function builderPodBlockReason(pod: BuilderPodStatus | null): string | null {
  if (pod?.status?.reason === 'DeadlineExceeded') {
    // The one failure the exec's own budgets cannot describe: a build that
    // kept producing output never trips the idle timeout, so the pod's
    // whole-pod deadline is what ended it — and kubectl, whose connection
    // died with the pod, only reports a signal.
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
  const pod = await kubectlGetJson<BuilderPodStatus>([
    'get', 'pod', name, '-n', k8sNamespace(),
  ]).catch(() => null)
  const reason = builderPodBlockReason(pod)
  return reason ? `builder pod ${name}: ${reason}` : null
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
 * registry step cache, and push the product.
 */
export async function buildLayerInPod(
  layer: ImageLayer,
  ctx: EngineBuildContext,
): Promise<void> {
  // The lease belongs to the ensureImage/rebuildProjectImage call that
  // created it — adjacent untrusted layers share one pod, and that caller's
  // `finally` releases it. Nothing here owns the pod's lifetime.
  const pod = await ctx.lease.acquire(layer.tag)
  const clusterHost = registryHost()
  const logPrefix = `[build ${layer.tag}] `
  const execOpts = { onLog: ctx.onLog, logPrefix }
  try {
    await runLayerBuild(pod, layer, ctx, clusterHost, execOpts)
  } catch (err) {
    // A failed exec may be the pod dying under it (the deadline above all),
    // which kubectl can only report as a signal — ask the pod itself.
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

  await execInBuilderPod(
    pod,
    ['podman', ...builderBuildArgs(layer, {
      dockerfileRel: plan.dockerfileRel,
      clusterHost,
      cacheRepo: buildCacheRepo(ctx.projectSlug),
    })],
    { ...execOpts, idleTimeoutMs: BUILDER_BUILD_IDLE_TIMEOUT_MS },
  )

  // Delta push: parent blobs were just pulled from this registry, so
  // podman's blob-info cache cross-repo-mounts them (~1.2s measured).
  // Always pushes (no HEAD skip) — a --no-cache rebuild must overwrite
  // the unchanged content-hash tag with fresh bytes.
  await execInBuilderPod(
    pod,
    ['podman', 'push', '--tls-verify=false', layer.tag, `${clusterHost}/${layer.tag}`],
    { ...execOpts, idleTimeoutMs: BUILDER_PUSH_IDLE_TIMEOUT_MS },
  )
}

/** Age past which a builder pod is unconditionally a leak: comfortably
 *  above BUILDER_ACTIVE_DEADLINE_SECONDS, so no live build can reach it. */
export const BUILDER_REAP_AGE_MS = 5 * 3600_000

const BUILDER_REAP_INTERVAL_MS = 10 * 60_000
let lastReapMs = 0

/**
 * When this server process started. A builder pod older than this belongs to
 * a previous one — the data-dir lock admits a single server per install, and
 * the selector is already scoped to this install — so it is a leak no matter
 * how young it is. Reaping it on age alone would leave its 8 GiB memory
 * reservation parked on the node, and since two builders do not fit on a
 * typical node, EVERY build after a restart fails to schedule until the
 * dead pod's active deadline fires hours later.
 */
const SERVER_START_MS = Date.now()

/** Test hook: reset the reap throttle. */
export function _resetBuilderReapForTests(): void {
  lastReapMs = 0
}

/**
 * Background sweep for leaked builder pods (server crashed mid-build):
 * deletes this install's role=builder pods that are terminal (the active
 * deadline already stopped them), predate this server process, or are older
 * than any live build can be. Internally throttled; the normal path deletes
 * pods inline in `release`.
 */
export async function reconcileBuilderPodGc(
  now = Date.now(),
  serverStartMs = SERVER_START_MS,
): Promise<void> {
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
    const orphaned = Number.isFinite(created) && created < serverStartMs
    if (phase !== 'Succeeded' && phase !== 'Failed' && !expired && !orphaned) continue
    serverLog(`[builder] reaping stale builder pod ${name} (phase ${phase})`)
    await deleteBuilderPod(name)
  }
}
