/**
 * GC of the main registry (`#drivers/k8s/cluster` main-registry.ts), the
 * install's one image bus. Two kinds of tag accumulate in it forever
 * unless something retires them, and each pass retires both:
 *
 * - **Step-cache entries** (docs/trust-split-builds.md). Every builder-pod
 *   build pushes one cache image per Dockerfile step into
 *   `yaac-buildcache-<id>`, tagged by cache key, and an edited Dockerfile
 *   mints fresh keys. Retired once no build has written them for
 *   BUILD_CACHE_TTL: `--cache-ttl` already makes those reads misses, so
 *   retirement costs no cache hit. The age signal is the tag link's mtime
 *   rather than the image's created timestamp, because a cache HIT
 *   re-pushes the entry and refreshes the link: retention is last-used,
 *   not first-built.
 * - **Content-hash generations** of every yaac-built repo (`yaac-base`,
 *   `yaac-tools`, `yaac-proj-<id>`, proxy, netd, the server; not the e2e
 *   suite's `yaac-test-*`). Each source change pushes a new tag and leaves
 *   the old one tagged. Retired by the per-project registries' retention
 *   pass (`buildRegistryRetentionScript`), handed the live set
 *   (`readLiveImages`) as tags it must never touch: every generation a pod
 *   or workload template names in ANY namespace, and every layer of every
 *   project's current chain. Past that, the newest
 *   MAIN_REGISTRY_GENERATIONS_KEPT per repo stay as rollback. Mirrors carry
 *   no content-hash tag and are never candidates.
 *
 * And one kind of whole repo: a project's own (`yaac-proj-<id>`,
 * `yaac-user-<id>`, `yaac-buildcache-<id>`) whose id no live project holds —
 * a removed project's, or one named before projects had ids
 * (`orphanProjectRepoSweepScript`). Permanent rather than a removal step,
 * so it also covers every removal that never ran.
 *
 * The same pass then drops the nodes' unpacked copies of whatever the
 * registry no longer holds (node-image-gc.ts), which is where most of the
 * bytes are.
 *
 * Untagging is a `rm -rf` of the tag directory in the registry's own
 * storage, and blobs are reclaimed by the registry binary's
 * `garbage-collect --delete-untagged` — the same storage-layout moves the
 * per-project registries' collect makes (`reconcileProjectRegistryGc`),
 * for the same reason: the delete API answers 405 unless the Deployment is
 * rolled with `REGISTRY_STORAGE_DELETE_ENABLED`. Both run through
 * `mainRegistryExec`, a `kubectl exec` into the registry Deployment's pod.
 *
 * `--delete-untagged` is global, not scoped to the repos swept here, which
 * makes one property of this registry load-bearing: everything in it lives
 * as a plain, tagged, single manifest. Blobs shared with a still-tagged
 * image survive because that manifest is marked, and the digest-pinned
 * mirrors are pushed as single-arch children under a tag of their own.
 * Anything stored untagged (a digest-only push) or as an index (a manifest
 * list, whose children the mark phase does not walk) would be collected
 * out from under its users.
 *
 * What this does NOT take is the sibling collect's read-only maintenance
 * window, which is how that one makes a live collect safe. Nothing stops it
 * any more — the shared registry is a Deployment over a PVC now, so rolling
 * it with the read-only env costs a restart and no images —
 * but adopting it is a behaviour change of its own (every push and delete
 * in the window answers 405) and is left as a follow-up. Until then the two
 * hazards are handled directly here:
 *
 * - A push racing the collect can have its blobs deleted between upload
 *   and manifest PUT, leaving an image that pulls broken forever (the
 *   server-side `registryHasTag` skip means nothing ever re-pushes it).
 *   Three signals hold the collect off: an in-progress upload, any link
 *   file written recently (a just-committed blob, a cross-repo mount, a
 *   just-PUT manifest — none of which leave an upload behind), and this
 *   server's own in-flight builds and pushes. The first two are read off
 *   the filesystem, so they see e2e servers and builder pods too, and both
 *   are re-read immediately before the collect, since the sweep that
 *   precedes it takes time. What remains open is a push that starts inside
 *   the collect: only the maintenance window would close that, so the
 *   collect is kept rare and short instead.
 * - The registry caches blob descriptors in memory. After a collection,
 *   re-pushing a deleted digest writes only the link, not the blob, so the
 *   tag 404s and stays broken (verified). The restart that clears those
 *   descriptors therefore runs in a `finally` — a collect that throws
 *   half-way through deleting is exactly when it is most needed — and a
 *   marker file in the registry's storage records that a collect was
 *   started, so a restart lost to a failing rollout or to the
 *   server dying mid-collect is retried by the next sweep. Nothing else
 *   would retry it: the tags this pass retired are already gone, so a
 *   later sweep finds nothing to retire and would never reach the restart.
 */
import {
  buildRegistryRetentionScript,
  mainRegistryExec,
  restartMainRegistry,
} from '#drivers/k8s/cluster'
import { kubectlGetJson } from '#drivers/k8s/substrate'
import { resolveImageChain } from '#drivers/k8s/image-engine'
import { testEnv } from '@yaac/shared/env'
import type { YaacConfig } from '@yaac/shared/types'
import type { ProjectRef } from '#drivers/contract'
import { serverLog } from '#log'
import { BUILD_CACHE_TTL } from './builder-pod'
import { forgetVerifiedTags, imageWorkInFlight } from './build-coordinator'
import { pruneNodeImages, registryGeneration } from './node-image-gc'

/** Min interval between sweeps — hygiene work, like the host image GC. */
export const MAIN_REGISTRY_GC_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Content-hash generations kept per repo beyond the live set: current plus
 * one rollback, the host engine's policy. Far below the project
 * registries' 8 because the live set here is KNOWN rather than guessed —
 * every generation a workload or a project's chain names is protected
 * outright, so the count only decides how much history is kept warm.
 */
const MAIN_REGISTRY_GENERATIONS_KEPT = 2

/**
 * The e2e suite's repos, which this pass never retires. A run resolves
 * them by tag from its global setup through its last file — long stretches
 * in which no pod names them and no namespace marks the run — and a run on
 * an older checkout uses generations the newest-two rule would not keep.
 * They are the suite's to retire (docs/plans/storage-gc-gaps.md).
 */
const TEST_IMAGE_REPOS = 'yaac-test-*'

/**
 * Retention in whole days, derived from the read-side `--cache-ttl` so the
 * two can't drift: a tag older than the TTL is already a miss. `find
 * -mtime` is the only age filter busybox offers, hence days. Read on call
 * rather than at import — the stacking tests mock this folder's builder-pod
 * module down to the two names they drive.
 */
export function buildCacheRetainDays(): number {
  return Math.max(1, Math.floor(Number.parseInt(BUILD_CACHE_TTL, 10) / 24))
}

/**
 * How recent an in-progress upload has to be to hold the sweep off. This
 * is not "when the push started": `-mmin` reads the upload's data file,
 * which every received chunk rewrites, so a slow but live upload keeps
 * counting as busy however long it runs. The bound only exists so uploads
 * abandoned by a crashed pusher (the registry purges them on its own, much
 * longer, schedule) can't wedge the GC forever.
 */
export const REGISTRY_UPLOAD_BUSY_MINUTES = 60

/**
 * How long the registry has to have been quiet — no link file written by
 * any pusher — before a collect may run. Covers the pushes an upload dir
 * cannot see: a blob that has committed but whose manifest has not landed
 * yet, and a delta push whose layers were cross-repo mounted. Short,
 * because that gap is seconds wide and a long window would mean an active
 * install never collects at all.
 */
export const REGISTRY_QUIET_MINUTES = 5

/** Registry:2 storage root, binary, and config inside the container. */
const REGISTRY_STORAGE_DIR = '/var/lib/registry'
const REGISTRY_REPOS_DIR = `${REGISTRY_STORAGE_DIR}/docker/registry/v2/repositories`
const REGISTRY_BINARY = '/bin/registry'
const REGISTRY_CONFIG = '/etc/docker/registry/config.yml'

/**
 * "A collect was started and no restart has succeeded since." Kept in the
 * registry's storage, not in this process: the case it exists for is the
 * server dying mid-collect. Outside the `docker/` tree, so the collect
 * itself never sees it.
 */
const COLLECT_MARKER = `${REGISTRY_STORAGE_DIR}/.yaac-collect-started`

const PROBE_TIMEOUT_MS = 60_000
const SWEEP_TIMEOUT_MS = 60_000
const COLLECT_TIMEOUT_MS = 10 * 60_000
const MARKER_TIMEOUT_MS = 30_000

/**
 * In-container deadline for the collect, just under the exec's. Without it
 * the exec's own timeout would kill the `kubectl exec` client and leave
 * `garbage-collect` deleting blobs inside the pod, unwatched, while the
 * restart runs under it.
 */
const COLLECT_KILL_SECONDS = Math.floor(COLLECT_TIMEOUT_MS / 1000) - 30

/**
 * The registry-side quiet check, in busybox `find`: an upload still being
 * written, or any link file (blob, manifest revision, tag) touched inside
 * the quiet window. Prints BUSY and nothing else, so the caller can treat
 * "said anything" as "stand down".
 */
export function registryQuietProbeScript(
  busyMinutes = REGISTRY_UPLOAD_BUSY_MINUTES,
  quietMinutes = REGISTRY_QUIET_MINUTES,
): string {
  return [
    'set -eu',
    `ROOT=${REGISTRY_REPOS_DIR}`,
    '[ -d "$ROOT" ] || exit 0',
    `if [ -n "$(find "$ROOT" -path '*/_uploads/*' -mmin -${busyMinutes} -print -quit 2>/dev/null)" ]; then`,
    '  echo BUSY',
    '  exit 0',
    'fi',
    // Deleting a tag directory writes no link, so the sweep's own untags
    // can never make this fire.
    `if [ -n "$(find "$ROOT" -name link -type f -mmin -${quietMinutes} -print -quit 2>/dev/null)" ]; then`,
    '  echo BUSY',
    'fi',
  ].join('\n')
}

/**
 * The in-container sweep: untag every `yaac-buildcache-*` entry whose tag
 * link is older than `days` and name it on stdout. A tag directory is
 * `<repo>/_manifests/tags/<key>`, holding `current/link` (the live
 * manifest) and an `index/` of past revisions; removing the directory
 * retires all of it, and the collect then frees whatever manifest and
 * blobs are left unreferenced.
 *
 * Written for the registry image's busybox shell: no `-newermt`, no
 * `-printf`, no arrays.
 */
export function buildCacheSweepScript(days = buildCacheRetainDays()): string {
  return [
    'set -eu',
    `ROOT=${REGISTRY_REPOS_DIR}`,
    '[ -d "$ROOT" ] || exit 0',
    'for tags in "$ROOT"/yaac-buildcache-*/_manifests/tags; do',
    '  [ -d "$tags" ] || continue',
    `  find "$tags" -mindepth 3 -maxdepth 3 -name link -mtime +${days} 2>/dev/null | while read -r link; do`,
    '    dir=$(dirname "$(dirname "$link")")',
    '    echo "RETIRED ${dir##*/}"',
    '    rm -rf "$dir"',
    '  done',
    'done',
  ].join('\n')
}

/** How old a project repo must be before the orphan sweep may take it —
 *  the registry GC's youth guard, on the repo directory's mtime. */
export const ORPHAN_REPO_MIN_AGE_MINUTES = 10

/**
 * The in-container sweep of whole project repos: untag every
 * `yaac-{proj,user,buildcache}-<x>` whose `x` is not a live project id,
 * unless a workload still names one of its tags (`keepRepos`) — a pod of a
 * project removed moments ago, or of another install sharing this
 * registry, has not stopped pulling it. Each is named on stdout as the
 * retention pass names its tags.
 *
 * The e2e suite's image repos (`yaac-test-…`) never match, which is how
 * the TEST_IMAGE_REPOS exemption reaches this pass too. Its step-cache
 * repos do (a cache repo carries no prefix), which costs a running suite
 * cache misses at worst: the quiet probe keeps this off a registry that is
 * being pushed to.
 */
export function orphanProjectRepoSweepScript(liveIds: string[], keepRepos: string[]): string {
  return [
    'set -eu',
    `ROOT=${REGISTRY_REPOS_DIR}`,
    '[ -d "$ROOT" ] || exit 0',
    // Ids and repo names are of the image-name charset, so single quotes
    // are safe.
    `LIVE=',${liveIds.join(',')},'`,
    `KEEP='${keepRepos.join('\n')}'`,
    'for dir in "$ROOT"/yaac-proj-* "$ROOT"/yaac-user-* "$ROOT"/yaac-buildcache-*; do',
    '  [ -d "$dir" ] || continue',
    // Too young to judge: a repo is made by its first push, and a project
    // added after this pass read the live set may be pushing it now.
    `  [ -n "$(find "$dir" -maxdepth 0 -mmin +${ORPHAN_REPO_MIN_AGE_MINUTES})" ] || continue`,
    '  repo=${dir##*/}',
    '  case "$LIVE" in *",${repo#yaac-*-},"*) continue;; esac',
    '  printf \'%s\\n\' "$KEEP" | grep -qxF "$repo" && continue',
    '  rm -rf "$dir" && echo "RETIRED $repo"',
    'done',
  ].join('\n')
}

interface MainRegistryGcResult {
  /** Cache keys and `repo:tag` generations untagged this sweep. */
  retired: string[]
  /** True when live push activity made the sweep stand down. */
  busy: boolean
  /** True when the blob collect actually ran. */
  collected: boolean
  /**
   * True unless a collect ran and its restart did not. False means the
   * registry is serving stale blob descriptors and the marker is waiting
   * for the next sweep — a pass in that state has not succeeded, whatever
   * it managed to reclaim.
   *
   * It means "the rollout succeeded" AND "the store this pass collected is
   * the one now being served" — the second half because the blobs are on a
   * PVC the replacement pod remounts. `Recreate` still deletes the old pod
   * before scheduling its replacement, so the registry may well come back
   * on a different node; that is now uneventful rather than a periodic
   * coin flip over which store the catalog reflects.
   */
  restored: boolean
}

/** True when the registry is serving a push right now, or just was. */
async function registryBusy(): Promise<boolean> {
  const stdout = await mainRegistryExec(
    ['sh', '-c', registryQuietProbeScript()],
    PROBE_TIMEOUT_MS,
  )
  return stdout.includes('BUSY')
}

/**
 * Bounce the registry, then drop the collect marker. The marker is cleared
 * LAST and only on success, so a restart that fails leaves the next sweep
 * to redo it. `restartMainRegistry` rolls the Deployment and drops this
 * process's port-forward, which was bound to the pod that just went away.
 */
async function restartRegistry(): Promise<void> {
  await restartMainRegistry()
  await mainRegistryExec(['rm', '-f', COLLECT_MARKER], MARKER_TIMEOUT_MS)
}

/** Did a previous pass start a collect that no restart has followed? */
async function collectMarkerPresent(): Promise<boolean> {
  const stdout = await mainRegistryExec(
    ['sh', '-c', `[ -f ${COLLECT_MARKER} ] && echo MARKED || true`],
    MARKER_TIMEOUT_MS,
  )
  return stdout.includes('MARKED')
}

/** What the retention pass must not retire, gathered before it runs. */
interface LiveImages {
  /** Every live project's id — what the orphan repo sweep keeps. */
  projectIds: string[]
  /** `repo:tag` of every generation a pod or workload names, any namespace. */
  inUse: Set<string>
  /**
   * `repo:tag` of every layer of every project's current chain, or null
   * when some project's chain could not be resolved — which makes the whole
   * generation half stand down (see `readLiveImages`).
   */
  wanted: Set<string> | null
}

interface RawWorkloadList {
  items: Array<{ spec?: PodSpecImages & { template?: { spec?: PodSpecImages } } }>
}
interface PodSpecImages {
  containers?: Array<{ image?: string }>
  initContainers?: Array<{ image?: string }>
}

/**
 * Every generation a pod or a workload template names, in any namespace.
 * Templates as well as pods, because a Deployment scaled to zero
 * (`yaac server stop`) names an image no pod does, and scaling it back up
 * must still find it; ReplicaSets too, because `kubectl rollout undo`
 * brings an older one's template back. Fails closed: an unreadable list
 * throws, and the pass stops before retiring anything.
 */
async function readInUse(): Promise<Set<string>> {
  const workloads = await kubectlGetJson<RawWorkloadList>([
    'get', 'pods,deployments,replicasets,daemonsets,jobs', '--all-namespaces',
  ])
  const inUse = new Set<string>()
  for (const { spec } of workloads?.items ?? []) {
    for (const s of [spec, spec?.template?.spec]) {
      for (const { image } of [...s?.containers ?? [], ...s?.initContainers ?? []]) {
        const generation = image ? registryGeneration(image) : null
        if (generation) inUse.add(generation)
      }
    }
  }
  return inUse
}

/**
 * Read the live set. The chains are the prewarm sweep's view of what each
 * project wants warm: a project with no running workspace still has a
 * current image, and retiring it would cost a rebuild on the next create —
 * in a builder pod, for the untrusted layers.
 *
 * A chain that cannot be resolved fails CLOSED for the whole pass, not
 * just that project: the likeliest cause — a non-layered `Dockerfile.user`
 * mid-edit — fails EVERY project's chain at once, and a pass that went on
 * would retire the generations of every chain it could not name.
 */
async function readLiveImages(
  projects: ProjectRef[],
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
): Promise<LiveImages> {
  const inUse = await readInUse()
  let wanted: Set<string> | null = new Set<string>()
  const prefix = testEnv.imagePrefix ?? 'yaac'
  for (const project of projects) {
    try {
      const nested = (await projectConfig(project.slug))?.nestedContainers === true
      const { layers, finalTag } = await resolveImageChain(project, prefix, nested)
      for (const tag of [...layers.map((l) => l.tag), finalTag]) wanted.add(tag)
    } catch (err) {
      serverLog(`[main-registry-gc] ${project.slug}: cannot resolve its image chain, `
        + `so no image generation is retired this pass: ${String(err)}`)
      wanted = null
      break
    }
  }
  return { projectIds: projects.map((p) => p.id), inUse, wanted }
}

/**
 * One GC pass over the registry: finish any restart a previous pass owed,
 * untag aged-out step-cache entries and superseded generations and, if the
 * registry is quiet enough to make it safe, collect the unreferenced blobs
 * and restart.
 */
async function gcMainRegistry(live: LiveImages): Promise<MainRegistryGcResult> {
  // Ahead of the busy probe on purpose, so this can bounce the registry
  // under a live push: serving stale descriptors is the worse state, and
  // an interrupted push is harmless — it never lands its manifest, so
  // `registryHasTag` misses and the pusher retries. The cost is one retry
  // for whatever was in flight, on a pass that only happens after a
  // restart was already lost.
  if (await collectMarkerPresent()) {
    serverLog('[main-registry-gc] a previous collect went unfinished, restarting the registry')
    await restartRegistry()
  }

  if (await registryBusy()) {
    return { retired: [], busy: true, collected: false, restored: true }
  }

  let stdout = await mainRegistryExec(['sh', '-c', buildCacheSweepScript()], SWEEP_TIMEOUT_MS)
  const inUseRepos = [...new Set([...live.inUse].map((ref) => ref.slice(0, ref.lastIndexOf(':'))))]
  stdout += `\n${await mainRegistryExec(
    ['sh', '-c', orphanProjectRepoSweepScript(live.projectIds, inUseRepos)],
    SWEEP_TIMEOUT_MS,
  )}`
  if (live.wanted) {
    stdout += `\n${await mainRegistryExec(['sh', '-c', buildRegistryRetentionScript({
      keep: MAIN_REGISTRY_GENERATIONS_KEPT,
      protect: [...live.inUse, ...live.wanted],
      skip: [TEST_IMAGE_REPOS],
    })], SWEEP_TIMEOUT_MS)}`
  }
  const retired = stdout.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('RETIRED '))
    .map((l) => l.slice('RETIRED '.length))
  if (retired.length === 0) return { retired, busy: false, collected: false, restored: true }
  // This server remembers which tags it has seen in the registry; a retired
  // one must be looked up again, or a create that resolves back to it
  // (a reverted Dockerfile edit) would hand a pod a ref that 404s. That
  // covers creates that START after the retirement. One that resolved
  // such a tag between the live-set read and the retention — a revert to
  // a generation at least three back, landing within those seconds — can
  // still have it retired under it; its pod fails to pull, and the next
  // create rebuilds the image.
  forgetVerifiedTags()

  // Re-read the push signals: the untag above took time, and the first
  // read is only as good as the instant it happened. Standing down here
  // costs nothing — the tags are untagged either way, and the next sweep
  // collects them.
  if (imageWorkInFlight() || await registryBusy()) {
    return { retired, busy: true, collected: false, restored: true }
  }

  await mainRegistryExec(['touch', COLLECT_MARKER], MARKER_TIMEOUT_MS)
  let restored = false
  try {
    await mainRegistryExec(
      [
        'timeout', String(COLLECT_KILL_SECONDS),
        REGISTRY_BINARY, 'garbage-collect', '--delete-untagged', REGISTRY_CONFIG,
      ],
      COLLECT_TIMEOUT_MS,
    )
  } finally {
    // Unconditional: a collect that threw part-way through deleting is
    // precisely the state the restart exists to clear.
    restored = await restartRegistry().then(() => true).catch((err: unknown) => {
      serverLog(
        '[main-registry-gc] the registry could not be restarted after a collect '
        + `and may resolve re-pushed digests to missing blobs until it is: ${String(err)}`,
      )
      return false
    })
  }
  return { retired, busy: false, collected: true, restored }
}

let lastSweepMs = 0

/** The pass running right now, if any. One at a time: a collect holds the
 *  registry for minutes and ends by restarting it. */
let inFlightPass: Promise<void> | null = null

/** Test hook: reset the sweep throttle and forget any in-flight pass. */
export function _resetMainRegistryGcForTests(): void {
  lastSweepMs = 0
  inFlightPass = null
}

/** Test hook: await the detached pass this reconcile started. */
export function _mainRegistryGcSettledForTests(): Promise<void> {
  return inFlightPass ?? Promise.resolve()
}

/**
 * Gated to the default install like the host image GC — e2e servers share
 * this registry (it lives in the default namespace precisely so they do),
 * and one collecting mid-run could pull a blob out from under another
 * run's push. Never two passes at once: a pass ends by restarting the
 * registry.
 */
function sweepDue(nowMs: number): boolean {
  if (testEnv.k8sNamespace !== 'yaac') return false
  if (inFlightPass) return false
  return nowMs - lastSweepMs >= MAIN_REGISTRY_GC_INTERVAL_MS
}

/**
 * Reconcile step: the registry pass, then the nodes' copies of what it
 * retired (node-image-gc.ts) — this pass's retirements and any an earlier
 * one left on a node. The node half runs even when the registry stood
 * down, since it only follows what the registry already dropped.
 *
 * DETACHED, for the same reason `reconcileProjectRegistryGc` detaches: a
 * pass that collects is minutes of exec plus a restart, and reconcile
 * passes are serialized, so awaiting it here would stall every later step
 * and every later tick behind it.
 */
export function reconcileMainRegistryGc(
  projects: ProjectRef[],
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!sweepDue(nowMs)) return Promise.resolve()
  lastSweepMs = nowMs
  inFlightPass = (async () => {
    const live = await readLiveImages(projects, projectConfig)
    const { retired, busy, collected, restored } = await gcMainRegistry(live)
    if (busy) {
      serverLog('[main-registry-gc] registry has pushes in flight, leaving the collect for later')
    } else if (collected && restored) {
      serverLog(`[main-registry-gc] retired ${retired.length} stale tag(s) and collected their blobs`)
    }
    // Re-read: the snapshot above predates the retention, a collect of up
    // to ten minutes, and the restart.
    await pruneNodeImages(await readInUse())
  })()
    .catch((err: unknown) => {
      // Not always a bug: an install whose cluster is down, or whose
      // registry Deployment has not been stood up yet, has nothing to exec
      // into. Log and let the next sweep try again.
      serverLog(`[main-registry-gc] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    .finally(() => { inFlightPass = null })
  return Promise.resolve()
}
