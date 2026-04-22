import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'

/**
 * Label marking a volume as the per-session podman graphroot for a
 * `nestedContainers: true` session. Written at volume-create time so the
 * daemon-startup orphan GC can distinguish our volumes from anything else
 * on the host.
 */
export const GRAPHROOT_LABEL = 'yaac.podmanstorage'

/**
 * Label marking a volume as the project-shared image cache (mounted into
 * sessions read-only as an `additionalimagestores` path, and rw into the
 * short-lived promoter container).
 */
export const IMAGECACHE_LABEL = 'yaac.imagecache'

/** In-container mount point for the shared image-cache volume (read-only). */
export const SHARED_IMAGE_STORE_PATH = '/var/lib/shared-images'

export function sessionGraphrootVolumeName(sessionId: string): string {
  return `yaac-podmanstorage-${sessionId}`
}

export function projectImageCacheVolumeName(projectSlug: string): string {
  return `yaac-imagecache-${projectSlug}`
}

interface VolumeLabels {
  [key: string]: string
}

async function ensureVolume(name: string, labels: VolumeLabels): Promise<void> {
  try {
    await podman.getVolume(name).inspect()
    return
  } catch {
    // not present — fall through to create
  }
  try {
    await podman.createVolume({ Name: name, Labels: labels })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('already exists')) throw err
  }
}

/**
 * Create (idempotently) the per-session graphroot volume and the project's
 * shared image-cache volume. Both carry `yaac.data-dir` so orphan GC can
 * tell them apart from other yaac installs sharing the same podman host.
 */
export async function ensureNestedStorageVolumes(
  projectSlug: string,
  sessionId: string,
): Promise<{ graphroot: string; imageCache: string }> {
  const graphroot = sessionGraphrootVolumeName(sessionId)
  const imageCache = projectImageCacheVolumeName(projectSlug)
  const dataDir = getDataDir()

  await ensureVolume(graphroot, {
    [GRAPHROOT_LABEL]: 'true',
    'yaac.project': projectSlug,
    'yaac.session-id': sessionId,
    'yaac.data-dir': dataDir,
  })
  await ensureVolume(imageCache, {
    [IMAGECACHE_LABEL]: 'true',
    'yaac.project': projectSlug,
    'yaac.data-dir': dataDir,
  })
  return { graphroot, imageCache }
}

export async function removeSessionGraphrootVolume(sessionId: string): Promise<void> {
  const name = sessionGraphrootVolumeName(sessionId)
  try {
    await podman.getVolume(name).remove({ force: true })
  } catch {
    // already gone or in use by a doomed container — next sweep will catch it
  }
}

export async function removeProjectImageCacheVolume(projectSlug: string): Promise<void> {
  const name = projectImageCacheVolumeName(projectSlug)
  try {
    await podman.getVolume(name).remove({ force: true })
  } catch {
    // already gone
  }
}

/**
 * Inner shell script for the promoter: take an exclusive flock on the shared
 * store, then skopeo-copy every image present in the source graphroot
 * (tagged and dangling) into the shared store unless it's already there.
 */
export const PROMOTER_SCRIPT = [
  'set -u',
  'mkdir -p /dst /tmp/src-run /tmp/dst-run',
  'touch /dst/.yaac-promoter.lock',
  'exec 9>/dst/.yaac-promoter.lock',
  'flock -x 9',
  'ids=$(podman --root /src/storage --runroot /tmp/src-run image ls -a -q --no-trunc 2>/dev/null || true)',
  'for id in $ids; do',
  '  if podman --root /dst --runroot /tmp/dst-run image exists "$id" 2>/dev/null; then continue; fi',
  '  skopeo copy --quiet "containers-storage:[overlay@/src/storage+/tmp/src-run]$id" "containers-storage:[overlay@/dst+/tmp/dst-run]$id" || true',
  'done',
].join('\n')

/**
 * Copy images from a session's per-session graphroot into the project's
 * shared image-cache volume. Runs skopeo inside a short-lived container
 * with both volumes mounted rw; serialization across concurrent promoters
 * is provided by flock on a sentinel file inside the shared volume.
 *
 * Best-effort: failures are logged and swallowed so teardown is never
 * blocked on cache salvage.
 *
 * `imageRef` is the nestable image tag — it already has podman+skopeo+flock.
 */
export async function promoteSessionImages(
  projectSlug: string,
  sessionId: string,
  imageRef: string,
): Promise<void> {
  const graphroot = sessionGraphrootVolumeName(sessionId)
  const imageCache = projectImageCacheVolumeName(projectSlug)

  try {
    const container = await podman.createContainer({
      Image: imageRef,
      Cmd: ['sh', '-c', PROMOTER_SCRIPT],
      User: 'root',
      Labels: {
        'yaac.promoter': 'true',
        'yaac.project': projectSlug,
        'yaac.session-id': sessionId,
        'yaac.data-dir': getDataDir(),
      },
      HostConfig: {
        AutoRemove: true,
        SecurityOpt: ['label=disable'],
        Binds: [
          `${graphroot}:/src:rw`,
          `${imageCache}:/dst:rw`,
        ],
      },
    })
    await container.start()
    await container.wait()
  } catch (err) {
    console.warn(
      `Image promoter for session ${sessionId} failed: ${(err as Error).message}`,
    )
  }
}

/**
 * Build the shell one-liner for running the promoter via `podman run` from
 * a background shell (e.g. detached cleanup). Uses the same
 * `PROMOTER_SCRIPT` as the dockerode path. The caller is responsible for
 * ensuring the quoted string is appended to a `sh -c`-compatible script.
 */
export function buildPromoterShellCommand(
  projectSlug: string,
  sessionId: string,
  imageRef: string,
): string {
  const graphroot = sessionGraphrootVolumeName(sessionId)
  const imageCache = projectImageCacheVolumeName(projectSlug)
  // Escape single quotes inside the inner script so the outer sh -c '...'
  // wrapper survives. The script has no single quotes today, but belt and
  // braces.
  const inner = PROMOTER_SCRIPT.replace(/'/g, `'\\''`)
  return [
    'podman run --rm',
    '--user root',
    '--security-opt label=disable',
    `-v ${graphroot}:/src:rw`,
    `-v ${imageCache}:/dst:rw`,
    imageRef,
    `sh -c '${inner}'`,
  ].join(' ')
}

interface VolumeListEntry {
  Name: string
  Labels?: Record<string, string> | null
}

interface VolumeListResponse {
  Volumes?: VolumeListEntry[] | null
}

/**
 * Daemon-startup sweep: remove per-session graphroot volumes whose session
 * container no longer exists in this data-dir. No layer salvage — any
 * cache that was not promoted at clean teardown is forfeit.
 */
export async function gcOrphanSessionVolumes(): Promise<void> {
  const dataDir = getDataDir()

  let liveSessionIds: Set<string>
  try {
    const containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${dataDir}`] },
    })
    liveSessionIds = new Set(
      containers
        .map((c) => c.Labels?.['yaac.session-id'])
        .filter((id): id is string => !!id),
    )
  } catch (err) {
    console.warn(`Orphan volume GC: failed to list containers: ${(err as Error).message}`)
    return
  }

  let volumeList: VolumeListResponse
  try {
    volumeList = await podman.listVolumes({
      filters: { label: [`${GRAPHROOT_LABEL}=true`, `yaac.data-dir=${dataDir}`] },
    }) as VolumeListResponse
  } catch (err) {
    console.warn(`Orphan volume GC: failed to list volumes: ${(err as Error).message}`)
    return
  }

  for (const v of volumeList.Volumes ?? []) {
    const sessionId = v.Labels?.['yaac.session-id']
    if (!sessionId) continue
    if (liveSessionIds.has(sessionId)) continue
    try {
      await podman.getVolume(v.Name).remove({ force: true })
      console.log(`Removed orphan session graphroot volume ${v.Name}`)
    } catch {
      // already gone or briefly in use — not worth retrying here
    }
  }
}
