/**
 * Registry GC for the trust-split step-cache repos (docs/trust-split-builds.md).
 *
 * Every builder-pod build pushes one cache image per Dockerfile step into
 * `yaac-buildcache-<slug>`, tagged by cache key. An edited Dockerfile mints
 * fresh keys and leaves the old ones behind forever: nothing in the
 * registry expires, so the repo grows a tag (and its layer blobs) per step
 * per edit for the life of the install.
 *
 * Policy: retire cache tags no build has written for BUILD_CACHE_TTL.
 * `--cache-ttl` already makes those reads misses, so retirement costs no
 * cache hit — it only stops paying for entries podman refuses to use. The
 * age signal is the tag link's mtime rather than the image's created
 * timestamp, because a cache HIT re-pushes the entry and refreshes the
 * link: retention is last-used, not first-built.
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
import { mainRegistryExec, restartMainRegistry } from '#drivers/k8s/cluster'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#log'
import { BUILD_CACHE_TTL } from './builder-pod'
import { imageWorkInFlight } from './build-coordinator'

/** Min interval between sweeps — hygiene work, like the host image GC. */
export const BUILD_CACHE_GC_INTERVAL_MS = 6 * 60 * 60 * 1000

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

export interface BuildCacheGcResult {
  /** Cache keys untagged this sweep. */
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

/**
 * One GC pass over the registry's step-cache repos: finish any restart a
 * previous pass owed, untag what aged out and, if the registry is quiet
 * enough to make it safe, collect the unreferenced blobs and restart.
 */
export async function gcRegistryBuildCache(): Promise<BuildCacheGcResult> {
  // Ahead of the busy probe on purpose, so this can bounce the registry
  // under a live push: serving stale descriptors is the worse state, and
  // an interrupted push is harmless — it never lands its manifest, so
  // `registryHasTag` misses and the pusher retries. The cost is one retry
  // for whatever was in flight, on a pass that only happens after a
  // restart was already lost.
  if (await collectMarkerPresent()) {
    serverLog('[build-cache-gc] a previous collect went unfinished, restarting the registry')
    await restartRegistry()
  }

  if (await registryBusy()) {
    return { retired: [], busy: true, collected: false, restored: true }
  }

  const stdout = await mainRegistryExec(
    ['sh', '-c', buildCacheSweepScript()],
    SWEEP_TIMEOUT_MS,
  )
  const retired = stdout.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('RETIRED '))
    .map((l) => l.slice('RETIRED '.length))
  if (retired.length === 0) return { retired, busy: false, collected: false, restored: true }

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
        '[build-cache-gc] the registry could not be restarted after a collect '
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
export function _resetBuildCacheGcForTests(): void {
  lastSweepMs = 0
  inFlightPass = null
}

/** Test hook: await the detached pass this reconcile started. */
export function _buildCacheGcSettledForTests(): Promise<void> {
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
  return nowMs - lastSweepMs >= BUILD_CACHE_GC_INTERVAL_MS
}

/**
 * Reconcile step. DETACHED, for the same reason `reconcileProjectRegistryGc`
 * detaches: a pass that collects is minutes of exec plus a restart, and
 * reconcile passes are serialized, so awaiting it here would stall every
 * later step and every later tick behind it.
 */
export function reconcileBuildCacheGc(nowMs: number = Date.now()): Promise<void> {
  if (!sweepDue(nowMs)) return Promise.resolve()
  lastSweepMs = nowMs
  inFlightPass = gcRegistryBuildCache()
    .then(({ retired, busy, collected, restored }) => {
      if (busy) {
        serverLog('[build-cache-gc] registry has pushes in flight, leaving the collect for later')
      } else if (collected && restored) {
        serverLog(`[build-cache-gc] retired ${retired.length} stale step-cache tag(s) and collected their blobs`)
      }
    })
    .catch((err: unknown) => {
      // Not always a bug: an install whose cluster is down, or whose
      // registry Deployment has not been stood up yet, has nothing to exec
      // into. Log and let the next sweep try again.
      serverLog(`[build-cache-gc] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    .finally(() => { inFlightPass = null })
  return Promise.resolve()
}
