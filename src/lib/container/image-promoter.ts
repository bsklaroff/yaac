import { spawn } from 'node:child_process'
import { keepIdEnabled, podman, shellPodmanWithRetry } from '@/lib/container/runtime'
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

/**
 * In-container mount point for the shared image-cache volume. Mounted rw
 * because podman's `additionalimagestores` unconditionally creates lock-file
 * directories inside the store path (containers/storage#1733, podman#22784),
 * so an `:ro` bind fails with "mkdir .../overlay-layers: read-only file
 * system" the first time the inner podman is invoked. The promoter is the
 * only intentional writer; session-side writes are lock files only.
 */
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

/**
 * Force-remove a podman volume via the CLI. Podman's Docker-compat
 * `DELETE /volumes/{name}` endpoint ignores the force parameter, so
 * dockerode's `volume.remove({ force: true })` silently no-ops when the
 * volume has any attachment history (even if no container is currently
 * using it). Shell out to `podman volume rm -f` instead.
 */
async function forceRemoveVolume(name: string): Promise<void> {
  try {
    await shellPodmanWithRetry(`podman volume rm -f ${name}`)
  } catch {
    // already gone
  }
}

export async function removeSessionGraphrootVolume(sessionId: string): Promise<void> {
  await forceRemoveVolume(sessionGraphrootVolumeName(sessionId))
}

export async function removeProjectImageCacheVolume(projectSlug: string): Promise<void> {
  await forceRemoveVolume(projectImageCacheVolumeName(projectSlug))
}

/**
 * Inner shell script for the promoter. Runs in three passes under an
 * exclusive flock on the shared store:
 *
 *   1. Copy every image (tagged + dangling build intermediates) from the
 *      source graphroot to `/dst` by id, so layer blobs are available for
 *      cross-session reuse.
 *   2. Restore tags on `/dst` for every tagged source image. Skopeo's
 *      `containers-storage:@<id>` transport drops names, so without this
 *      pass a `FROM alpine:3.20` in a later session would miss the
 *      additionalimagestores lookup and fall back to a registry pull.
 *   3. Prune dangling images on `/dst` older than 7d. Tag re-points
 *      (session-N rebuilds `myapp:v1` to a new id → old id goes dangling)
 *      accumulate otherwise; the 7d window keeps recent build intermediates
 *      around so podman's build cache still hits across sessions.
 *
 * The source graphroot must be mounted at the session's original storage
 * path (`/home/yaac/.local/share/containers`). Podman's sqlite db records
 * the static dir it was created under and refuses to open it from a
 * different path ("database configuration mismatch"), so remounting at
 * `/src` is not viable. The destination store is fresh, so it can live
 * anywhere — we use `/dst` with an explicit `--root` override.
 */
export const PROMOTER_SCRIPT = [
  'set -u',
  'mkdir -p /dst /tmp/dst-run',
  'touch /dst/.yaac-promoter.lock',
  'exec 9>/dst/.yaac-promoter.lock',
  'flock -x 9',
  // log() fans every step out to stdout (which `yaac session promote`
  // streams) AND appends to a persistent log inside the shared cache volume,
  // so the silent teardown paths still leave an audit trail of what was
  // promoted and what failed.
  'log() { echo "[promoter] $*"; echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> /dst/.yaac-promoter.log; }',
  `log "start uid=$(id -u) HOME=$HOME graphRoot=$(podman info --format '{{.Store.GraphRoot}}' 2>&1)"`,
  // Pass 1 — copy by id. `podman image ls -q --no-trunc` emits ids
  // prefixed with "sha256:"; skopeo's containers-storage transport parses
  // a bare `sha256:<hex>` as a name+tag (→ docker.io/library/sha256:<hex>),
  // so strip the prefix and pass through `@<hex>` for an unambiguous
  // image-id reference. skopeo's stderr is captured into `err` so a failure
  // is reported (not silently swallowed); the `if` keeps it best-effort —
  // a bad copy never aborts the remaining images.
  // Capture `image ls` stderr so a read failure (ownership/userns mismatch,
  // storage-driver mismatch, wrong HOME/graphroot) is logged instead of
  // silently yielding an empty id list and a misleading "found 0".
  'lserr=$(mktemp)',
  'ids=$(podman image ls -a -q --no-trunc 2>"$lserr" | sed -e "s/^sha256://" || true)',
  '[ -s "$lserr" ] && log "podman image ls stderr: $(tr "\\n" " " < "$lserr")"',
  'rm -f "$lserr"',
  'nfound=$(echo "$ids" | grep -c . || true)',
  // Cross-check against the on-disk store: count image-id dirs under
  // overlay-images (excluding the images.json / images.lock metadata files).
  // If the store holds image dirs but podman listed none, the read failed —
  // the store is not actually empty.
  `nmeta=$(ls -1 "$HOME/.local/share/containers/storage/overlay-images" 2>/dev/null | grep -vc '^images\\.' || true)`,
  'log "found $nfound image id(s) in source graphroot (overlay-images dirs on disk: $nmeta)"',
  '[ "$nfound" = "0" ] && [ "${nmeta:-0}" != "0" ] && log "WARN: store holds $nmeta image dir(s) but podman listed 0 — the source graphroot could not be read (ownership/userns or storage-driver mismatch)"',
  'copied=0; skipped=0; failed=0',
  'for id in $ids; do',
  '  if podman --root /dst --runroot /tmp/dst-run image exists "$id" 2>/dev/null; then',
  '    log "SKIP  $id (already in shared cache)"; skipped=$((skipped+1)); continue',
  '  fi',
  '  if err=$(skopeo copy "containers-storage:@$id" "containers-storage:[overlay@/dst+/tmp/dst-run]@$id" 2>&1); then',
  '    log "COPY  $id OK"; copied=$((copied+1))',
  '  else',
  '    log "COPY  $id FAILED: $err"; failed=$((failed+1))',
  '  fi',
  'done',
  'log "copy summary: copied=$copied skipped=$skipped failed=$failed"',
  // Pass 2 — restore tags so FROM refs and `podman run <name>` resolve
  // from additionalimagestores without a registry round-trip. Drop the
  // `<none>:<none>` rows (dangling images) already handled by-id in pass 1.
  `podman image ls --no-trunc --format '{{.ID}}|{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '|<none>:<none>$' | while IFS='|' read -r tid tref; do`,
  '  [ -z "$tid" ] && continue',
  '  if podman --root /dst --runroot /tmp/dst-run tag "$tid" "$tref" 2>/dev/null; then log "TAG   $tref"; else log "TAG   $tref FAILED"; fi',
  'done',
  // Pass 3 — GC dangling images on /dst older than 7d (168h). Catches
  // ex-tagged images orphaned by later tag re-points; 168h is long enough
  // that recent build intermediates still back podman's build cache.
  `podman --root /dst --runroot /tmp/dst-run image prune --filter 'dangling=true' --filter 'until=168h' -f 2>/dev/null || true`,
  `log "shared cache now holds $(podman --root /dst --runroot /tmp/dst-run image ls -aq 2>/dev/null | wc -l | tr -d ' ') image(s)"`,
  'log "done"',
].join('\n')

/**
 * Single source of truth for the promoter's `podman run` argv (sans the
 * leading `podman`). Every launcher derives from this so the container is
 * byte-for-byte identical no matter how it's started: `promoteSessionImages`
 * spawns it directly, and `buildPromoterShellCommand` shell-quotes it for the
 * detached teardown path.
 *
 * `keepId` is injectable for tests; in production it defaults to
 * `keepIdEnabled()`. keep-id maps the promoter's `yaac` user to the host
 * daemon UID so the source graphroot (yaac-owned on host) is readable on
 * Linux rootless podman; `YAAC_DISABLE_KEEP_ID=1` omits it.
 */
export function buildPromoterRunArgs(opts: {
  projectSlug: string
  sessionId: string
  imageRef: string
  keepId?: boolean
}): string[] {
  const { projectSlug, sessionId, imageRef } = opts
  const keepId = opts.keepId ?? keepIdEnabled()
  const graphroot = sessionGraphrootVolumeName(sessionId)
  const imageCache = projectImageCacheVolumeName(projectSlug)
  return [
    'run', '--rm',
    // Run as yaac so the source graphroot (yaac-owned in the original
    // session) is readable and the sqlite db's recorded static dir matches.
    '--user', 'yaac',
    ...(keepId ? ['--userns', 'keep-id'] : []),
    '--security-opt', 'label=disable',
    // Labels mirror the old dockerode path so orphan promoter containers are
    // still identifiable for GC/debugging.
    '--label', 'yaac.promoter=true',
    '--label', `yaac.project=${projectSlug}`,
    '--label', `yaac.session-id=${sessionId}`,
    '--label', `yaac.data-dir=${getDataDir()}`,
    // The nestable image's ENTRYPOINT is `catatonit -- sleep infinity`;
    // override it so `-c <script>` drives the container.
    '--entrypoint', '/bin/sh',
    // Source graphroot must live at the session's original storage path:
    // podman's sqlite db bakes that path in and rejects `--root` overrides.
    '-v', `${graphroot}:/home/yaac/.local/share/containers:rw`,
    // Mount the shared cache at the additionalimagestores path too, not just
    // at the /dst destination. The session built its images with this cache
    // mounted as an additional store, so an image built `FROM <cached-base>`
    // (or any pulled image whose lower layers were already cached) keeps those
    // lower layers in the cache, not the graphroot. Without this mount the
    // source store can't resolve them — podman reports "top layer ... not
    // found in layer tree" and lists zero images, so the promoter copies
    // nothing. With it, the full layer tree resolves; skopeo copies only the
    // new top layer(s) and skips lower layers already present in the cache.
    // rw (not ro) because additionalimagestores unconditionally creates
    // lock-file dirs in the store path (see SHARED_IMAGE_STORE_PATH).
    '-v', `${imageCache}:${SHARED_IMAGE_STORE_PATH}:rw`,
    '-v', `${imageCache}:/dst:rw`,
    imageRef,
    '-c', PROMOTER_SCRIPT,
  ]
}

/**
 * Split a stream of chunks into newline-terminated lines, invoking `onLine`
 * for each complete line. Returns a `flush()` to emit any trailing partial
 * line once the stream closes.
 */
function makeLineSplitter(onLine: (line: string) => void): {
  push: (chunk: Buffer) => void
  flush: () => void
} {
  let buf = ''
  return {
    push: (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    },
    flush: () => {
      if (buf) { onLine(buf); buf = '' }
    },
  }
}

/**
 * Copy images from a session's per-session graphroot into the project's
 * shared image-cache volume by running the promoter container (skopeo +
 * flock) to completion. The one launcher used by both production teardown
 * (`cleanupSession`, no `onLog`) and the `yaac session promote` debug command
 * (`onLog` streams each promoter log line to the caller).
 *
 * Best-effort: a non-zero exit or spawn failure is returned (and warned), not
 * thrown, so teardown is never blocked on cache salvage. Resolves with the
 * container's exit code (0 = success, -1 = the promoter could not be spawned).
 *
 * `imageRef` is the nestable image tag — it already has podman+skopeo+flock.
 */
export async function promoteSessionImages(
  projectSlug: string,
  sessionId: string,
  imageRef: string,
  opts: { onLog?: (line: string) => void } = {},
): Promise<number> {
  const args = buildPromoterRunArgs({ projectSlug, sessionId, imageRef })
  try {
    return await new Promise<number>((resolve, reject) => {
      // `podman run --rm` (foreground) removes the container after it exits
      // and only then returns, so awaiting `close` blocks until the container
      // is fully gone — leaving the shared cache volume free for removal in
      // the same teardown flow (the property the old no-AutoRemove path had).
      const child = spawn('podman', args, {
        stdio: ['ignore', opts.onLog ? 'pipe' : 'ignore', opts.onLog ? 'pipe' : 'ignore'],
      })
      if (opts.onLog) {
        const splitter = makeLineSplitter(opts.onLog)
        child.stdout?.on('data', splitter.push)
        child.stderr?.on('data', splitter.push)
        child.on('close', () => splitter.flush())
      }
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? 0))
    })
  } catch (err) {
    console.warn(
      `Image promoter for session ${sessionId} failed: ${(err as Error).message}`,
    )
    return -1
  }
}

/**
 * Shell-escape one argv token by single-quoting it (and escaping any embedded
 * single quotes), so the joined string survives an outer `sh -c`.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * Build the shell one-liner for running the promoter via `podman run` from a
 * background shell (e.g. detached cleanup). Shell-quotes the same argv as
 * `promoteSessionImages` so both drive a byte-for-byte identical container.
 * The caller is responsible for appending it to a `sh -c`-compatible script.
 */
export function buildPromoterShellCommand(
  projectSlug: string,
  sessionId: string,
  imageRef: string,
): string {
  const args = buildPromoterRunArgs({ projectSlug, sessionId, imageRef })
  return `podman ${args.map(shellQuote).join(' ')}`
}

interface VolumeListEntry {
  Name: string
  Labels?: Record<string, string> | null
}

interface VolumeListResponse {
  Volumes?: VolumeListEntry[] | null
}

/**
 * Resolve a session's id + project slug from its per-session graphroot
 * volume's labels, accepting a full session id or a unique prefix. The
 * graphroot volume is the right source of truth for the promoter: it carries
 * `yaac.project` and outlives the session container, but is removed after a
 * normal `session delete` — so a "not found" here means there is nothing left
 * to promote. Throws on no match or an ambiguous prefix.
 */
export async function resolvePromotableSession(
  idOrPrefix: string,
): Promise<{ sessionId: string; projectSlug: string }> {
  const dataDir = getDataDir()
  let volumeList: VolumeListResponse
  try {
    volumeList = await podman.listVolumes({
      filters: { label: [`${GRAPHROOT_LABEL}=true`, `yaac.data-dir=${dataDir}`] },
    }) as VolumeListResponse
  } catch (err) {
    throw new Error(`Failed to list podman volumes: ${(err as Error).message}`)
  }

  const matches = (volumeList.Volumes ?? []).filter((v) => {
    const sid = v.Labels?.['yaac.session-id']
    return !!sid && (sid === idOrPrefix || sid.startsWith(idOrPrefix))
  })

  if (matches.length === 0) {
    throw new Error(
      `No per-session graphroot volume found for session "${idOrPrefix}". ` +
      'The promoter only applies to nestedContainers sessions, and the ' +
      'volume is removed after a normal `session delete`.',
    )
  }

  // An exact id match wins even when the prefix also matched longer ids.
  const exact = matches.find((v) => v.Labels?.['yaac.session-id'] === idOrPrefix)
  if (!exact && matches.length > 1) {
    const ids = matches.map((v) => v.Labels?.['yaac.session-id']).join(', ')
    throw new Error(`Ambiguous session prefix "${idOrPrefix}" matches: ${ids}`)
  }
  const chosen = exact ?? matches[0]

  return {
    sessionId: chosen.Labels?.['yaac.session-id'] ?? '',
    projectSlug: chosen.Labels?.['yaac.project'] ?? '',
  }
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
    await forceRemoveVolume(v.Name)
    console.log(`Removed orphan session graphroot volume ${v.Name}`)
  }
}
