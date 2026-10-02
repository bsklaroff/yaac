/**
 * GC of the main registry: retires aged-out step-cache tags, old
 * content-hash generations and orphaned project repos, collects the
 * unreferenced blobs, then prunes the nodes' copies
 * (node-image-gc.ts). docs/image-gc.md "The main registry" describes each
 * step.
 *
 * Untagging is an `rm -rf` in the registry's storage, and blobs are freed
 * by `registry garbage-collect --delete-untagged`, both via
 * `mainRegistryExec` (the delete API is disabled). `--delete-untagged` is
 * global, so everything in this registry must be a plain tagged
 * single-arch manifest; an untagged push or a manifest list would be
 * collected out from under its users.
 *
 * The collect runs without a read-only window, so a push racing it could
 * lose blobs. It is skipped while any upload is in progress, a link file
 * was written recently, or this server is building, and those checks are
 * repeated just before it runs. The registry keeps no blob-descriptor
 * cache (main-registry.ts), so it needs no restart afterwards.
 */
import { buildRegistryRetentionScript, mainRegistryExec } from '#drivers/k8s/cluster'
import { kubectlGetJson } from '#drivers/k8s/substrate'
import { resolveImageChain } from '#drivers/k8s/image-engine'
import { testEnv } from '@yaac/shared/env'
import type { YaacConfig } from '@yaac/shared/types'
import type { ProjectRef } from '#drivers/contract'
import { serverLog } from '#log'
import { BUILD_CACHE_TTL } from './builder-pod'
import { forgetVerifiedTags, imageWorkInFlight } from './build-coordinator'
import { pruneNodeImages, registryGeneration } from './node-image-gc'

/**
 * Generations kept per repo beyond the live set. Lower than the project
 * registries' 8 because here the live set is known and always protected.
 */
const MAIN_REGISTRY_GENERATIONS_KEPT = 2

/**
 * The e2e suite's repos, never retired here: a run uses them for its whole
 * duration, often with no pod naming them. The suite retires them itself.
 */
const TEST_IMAGE_REPOS = 'yaac-test-*'

/**
 * Step-cache retention in whole days (busybox `find -mtime`), derived from
 * `--cache-ttl`, past which a tag is already a cache miss. Computed on call
 * because some tests mock builder-pod.
 */
function buildCacheRetainDays(): number {
  return Math.max(1, Math.floor(Number.parseInt(BUILD_CACHE_TTL, 10) / 24))
}

/**
 * An upload whose data file changed within this many minutes counts as in
 * progress. Each chunk rewrites the file, so a slow live upload stays
 * busy; the bound keeps abandoned uploads from blocking GC forever.
 */
const REGISTRY_UPLOAD_BUSY_MINUTES = 60

/**
 * Minutes with no link file written before a collect may run. Covers
 * pushes with no upload in progress (a committed blob awaiting its
 * manifest, a cross-repo mount). Short, so a busy install still collects.
 */
const REGISTRY_QUIET_MINUTES = 5

/** Registry:2 storage root, binary, and config inside the container. */
const REGISTRY_STORAGE_DIR = '/var/lib/registry'
const REGISTRY_REPOS_DIR = `${REGISTRY_STORAGE_DIR}/docker/registry/v2/repositories`
const REGISTRY_BINARY = '/bin/registry'
const REGISTRY_CONFIG = '/etc/docker/registry/config.yml'

const PROBE_TIMEOUT_MS = 60_000
const SWEEP_TIMEOUT_MS = 60_000
const COLLECT_TIMEOUT_MS = 10 * 60_000

/**
 * In-container deadline for the collect, just under the exec's, so
 * `garbage-collect` is never left running unwatched.
 */
const COLLECT_KILL_SECONDS = Math.floor(COLLECT_TIMEOUT_MS / 1000) - 30

/**
 * Busybox script printing BUSY if an upload is in progress or any link
 * file was written inside the quiet window.
 */
function registryQuietProbeScript(
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
    `if [ -n "$(find "$ROOT" -name link -type f -mmin -${quietMinutes} -print -quit 2>/dev/null)" ]; then`,
    '  echo BUSY',
    'fi',
  ].join('\n')
}

/**
 * Busybox script that untags every `yaac-buildcache-*` entry whose tag link
 * is older than `days` (by removing `<repo>/_manifests/tags/<key>`) and
 * prints each as `RETIRED <key>`. A cache hit re-pushes the entry and
 * refreshes the link, so age means time since last use.
 */
function buildCacheSweepScript(days = buildCacheRetainDays()): string {
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

/** Minimum repo directory age before the orphan sweep may remove it. */
const ORPHAN_REPO_MIN_AGE_MINUTES = 10

/**
 * Busybox script that removes every `yaac-{proj,user,buildcache}-<x>` repo
 * whose `x` is not a live project id, unless a workload still uses it
 * (`keepRepos`). Prints `RETIRED <repo>` for each. `yaac-test-*` repos
 * never match.
 */
function orphanProjectRepoSweepScript(liveIds: string[], keepRepos: string[]): string {
  return [
    'set -eu',
    `ROOT=${REGISTRY_REPOS_DIR}`,
    '[ -d "$ROOT" ] || exit 0',
    // Ids and repo names cannot contain quotes.
    `LIVE=',${liveIds.join(',')},'`,
    `KEEP='${keepRepos.join('\n')}'`,
    'for dir in "$ROOT"/yaac-proj-* "$ROOT"/yaac-user-* "$ROOT"/yaac-buildcache-*; do',
    '  [ -d "$dir" ] || continue',
    // Skip young repos: a just-added project may be pushing its first image.
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
}

/** True when the registry is serving a push right now, or just was. */
async function registryBusy(): Promise<boolean> {
  const stdout = await mainRegistryExec(
    ['sh', '-c', registryQuietProbeScript()],
    PROBE_TIMEOUT_MS,
  )
  return stdout.includes('BUSY')
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
 * Every generation a pod or workload template names, in any namespace.
 * Templates count because a Deployment scaled to zero still needs its
 * image, and ReplicaSets because `kubectl rollout undo` restores them.
 * Throws if the list cannot be read, stopping the pass.
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
 * Read the live set: images in use, plus every project's current chain
 * (a project with no running workspace still needs its image). If any
 * chain cannot be resolved, `wanted` is null and no generations are
 * retired this pass; the usual cause, a broken `Dockerfile.user`, breaks
 * every chain at once.
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
      const { layers } = await resolveImageChain(project, prefix, nested)
      for (const { tag } of layers) wanted.add(tag)
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
 * One GC pass over the registry: untag, and, if the registry is still
 * quiet, collect.
 */
async function gcMainRegistry(live: LiveImages): Promise<MainRegistryGcResult> {
  if (await registryBusy()) return { retired: [], busy: true, collected: false }

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
  if (retired.length === 0) return { retired, busy: false, collected: false }
  // A create that resolves back to a retired tag (a reverted Dockerfile
  // edit) must check the registry again rather than trust the cache.
  forgetVerifiedTags()

  // Re-check, since untagging took time. Skipping is cheap: the next pass
  // collects these.
  if (imageWorkInFlight() || await registryBusy()) return { retired, busy: true, collected: false }

  await mainRegistryExec(
    [
      'timeout', String(COLLECT_KILL_SECONDS),
      REGISTRY_BINARY, 'garbage-collect', '--delete-untagged', REGISTRY_CONFIG,
    ],
    COLLECT_TIMEOUT_MS,
  )
  return { retired, busy: false, collected: true }
}

/** The pass running now, if any; passes never overlap. */
let inFlightPass: Promise<void> | null = null

/** Test hook: forget any in-flight pass. */
export function _resetMainRegistryGcForTests(): void {
  inFlightPass = null
}

/** Test hook: await the detached pass this reconcile started. */
export function _mainRegistryGcSettledForTests(): Promise<void> {
  return inFlightPass ?? Promise.resolve()
}

/**
 * Reconcile step: the registry pass, then the node prune (which runs even
 * when the registry pass stood down). Runs in the background, since a
 * collect takes minutes and would stall the serialized reconcile loop.
 *
 * Only the default install collects: e2e servers share this registry, and
 * one collecting mid-run could delete a blob another run is pushing.
 */
export function reconcileMainRegistryGc(
  projects: ProjectRef[],
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
): Promise<void> {
  if (testEnv.k8sNamespace !== 'yaac' || inFlightPass) return Promise.resolve()
  inFlightPass = (async () => {
    const live = await readLiveImages(projects, projectConfig)
    const { retired, busy, collected } = await gcMainRegistry(live)
    if (busy) {
      serverLog('[main-registry-gc] registry has pushes in flight, leaving the collect for later')
    } else if (collected) {
      serverLog(`[main-registry-gc] retired ${retired.length} stale tag(s) and collected their blobs`)
    }
    // Re-read: the earlier snapshot may be minutes old.
    await pruneNodeImages(await readInUse())
  })()
    .catch((err: unknown) => {
      // E.g. the cluster is down or the registry is not deployed yet.
      serverLog(`[main-registry-gc] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    .finally(() => { inFlightPass = null })
  return Promise.resolve()
}
