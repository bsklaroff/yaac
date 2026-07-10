import { containerExec, execTarget } from '@/lib/k8s/exec'
import { dataDirHash, k8sNamespace } from '@/lib/k8s/kubectl'
import { NESTED_GRAPHROOT_PATH, SHARED_IMAGE_STORE_DST_PATH } from '@/lib/k8s/pod-spec'

/**
 * Node-local hostPath backing a project's cross-session shared image
 * store, mounted rw at SHARED_IMAGE_STORE_PATH in every nested session
 * pod of the project. Node-local (not under the data dir) on purpose:
 * podman's storage layout is hostile to virtiofs (rename/lock patterns),
 * and loss on cluster recreate only costs warm caches. The data-dir hash
 * keeps coexisting installs (e2e runs) out of each other's stores.
 */
export function sharedImageStoreHostPath(projectSlug: string): string {
  return `/var/lib/yaac/imagecache/${dataDirHash()}/${projectSlug}`
}

/**
 * Promoter script, run INSIDE the session pod (as yaac) just before the
 * Job is deleted. Copies images from the session's per-pod graphroot
 * (emptyDir — about to vanish with the pod) into the project's shared
 * image store, giving later sessions `docker build` layer-cache hits via
 * `additionalimagestores`. Three passes under an exclusive flock on the
 * shared store:
 *
 *   1. Copy every image (tagged + dangling build intermediates) from the
 *      graphroot to the store by id, so layer blobs are available for
 *      cross-session reuse.
 *   2. Restore tags on the store for every tagged source image. Skopeo's
 *      `containers-storage:@<id>` transport drops names, so without this
 *      pass a `FROM alpine:3.20` in a later session would miss the
 *      additionalimagestores lookup and fall back to a registry pull.
 *   3. Prune dangling store images older than 7d (168h). Tag re-points
 *      (session-N rebuilds `myapp:v1` to a new id → old id goes dangling)
 *      accumulate otherwise; the window keeps recent build intermediates
 *      around so podman's build cache still hits across sessions. This is
 *      the GC story for the store.
 *
 * Self-gating: non-nested session pods have neither the store mount nor a
 * podman binary, so the script exits 0 immediately — cleanup can invoke
 * it unconditionally.
 *
 * The destination is addressed through SHARED_IMAGE_STORE_DST_PATH — a
 * SECOND mount of the same hostPath. The store is also listed in the
 * session's `additionalimagestores`, which podman opens read-only, so a
 * destination addressed as SHARED_IMAGE_STORE_PATH cannot get a
 * read-write lock ("not a read-write lock"). Writing through the distinct
 * dst path (which podman doesn't recognize as its own additional store)
 * gets the write lock; the bytes land in the same directory the next
 * session reads via SHARED_IMAGE_STORE_PATH. The source side uses the
 * default config: the graphroot must stay at the path its sqlite db was
 * created under (NESTED_GRAPHROOT_PATH), and the additional store must be
 * visible so images whose lower layers live in the cache still resolve
 * (skopeo then copies only the new top layers).
 */
export const PROMOTER_SCRIPT = [
  'set -u',
  `[ -d ${SHARED_IMAGE_STORE_DST_PATH} ] || exit 0`,
  'command -v podman >/dev/null 2>&1 || exit 0',
  'mkdir -p /tmp/dst-run',
  `touch ${SHARED_IMAGE_STORE_DST_PATH}/.yaac-promoter.lock`,
  `exec 9>${SHARED_IMAGE_STORE_DST_PATH}/.yaac-promoter.lock`,
  'flock -x 9',
  // log() fans every step out to stdout (which cleanupSession surfaces in
  // the server log) AND appends to a persistent log inside the shared
  // store, so the detached teardown path still leaves an audit trail.
  `log() { echo "[promoter] $*"; echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> ${SHARED_IMAGE_STORE_DST_PATH}/.yaac-promoter.log; }`,
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
  `nmeta=$(ls -1 "${NESTED_GRAPHROOT_PATH}/storage/overlay-images" 2>/dev/null | grep -vc '^images\\.' || true)`,
  'log "found $nfound image id(s) in source graphroot (overlay-images dirs on disk: $nmeta)"',
  '[ "$nfound" = "0" ] && [ "${nmeta:-0}" != "0" ] && log "WARN: store holds $nmeta image dir(s) but podman listed 0 — the source graphroot could not be read"',
  'copied=0; skipped=0; failed=0',
  'for id in $ids; do',
  `  if podman --root ${SHARED_IMAGE_STORE_DST_PATH} --runroot /tmp/dst-run image exists "$id" 2>/dev/null; then`,
  '    log "SKIP  $id (already in shared cache)"; skipped=$((skipped+1)); continue',
  '  fi',
  `  if err=$(skopeo copy "containers-storage:@$id" "containers-storage:[overlay@${SHARED_IMAGE_STORE_DST_PATH}+/tmp/dst-run]@$id" 2>&1); then`,
  '    log "COPY  $id OK"; copied=$((copied+1))',
  '  else',
  '    log "COPY  $id FAILED: $err"; failed=$((failed+1))',
  '  fi',
  'done',
  'log "copy summary: copied=$copied skipped=$skipped failed=$failed"',
  // Pass 2 — restore tags so FROM refs and `docker run <name>` resolve
  // from additionalimagestores without a registry round-trip. Drop the
  // `<none>:<none>` rows (dangling images) already handled by-id in pass 1.
  `podman image ls --no-trunc --format '{{.ID}}|{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '|<none>:<none>$' | while IFS='|' read -r tid tref; do`,
  '  [ -z "$tid" ] && continue',
  `  if podman --root ${SHARED_IMAGE_STORE_DST_PATH} --runroot /tmp/dst-run tag "$tid" "$tref" 2>/dev/null; then log "TAG   $tref"; else log "TAG   $tref FAILED"; fi`,
  'done',
  // Pass 3 — GC dangling store images older than 7d (168h).
  `podman --root ${SHARED_IMAGE_STORE_DST_PATH} --runroot /tmp/dst-run image prune --filter 'dangling=true' --filter 'until=168h' -f 2>/dev/null || true`,
  `log "shared cache now holds $(podman --root ${SHARED_IMAGE_STORE_DST_PATH} --runroot /tmp/dst-run image ls -aq 2>/dev/null | wc -l | tr -d ' ') image(s)"`,
  'log "done"',
].join('\n')

/**
 * Shell-escape one token by single-quoting it (and escaping any embedded
 * single quotes), so the joined string survives an outer `sh -c`.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** The in-container command tail that runs the promoter script. */
export function promoterExecCommand(): string {
  return `sh -c ${shellQuote(PROMOTER_SCRIPT)}`
}

/**
 * Run the promoter to completion inside the session pod via kubectl exec.
 * Best-effort: a non-zero exit, a dead pod, or an unreachable cluster is
 * warned and swallowed — teardown is never blocked on cache salvage.
 * Returns true when the promoter ran cleanly.
 */
export async function promoteSessionImages(jobName: string): Promise<boolean> {
  try {
    await containerExec(jobName, promoterExecCommand(), {
      timeout: 300_000,
      maxAttempts: 1,
    })
    return true
  } catch (err) {
    console.warn(
      `Image promoter for ${jobName} failed: ${(err as Error).message}`,
    )
    return false
  }
}

/**
 * The promoter as one host-shell line for the detached cleanup script —
 * byte-for-byte the same in-pod command as `promoteSessionImages`, with
 * `|| true` so a dead pod never blocks the Job deletion that follows.
 */
export function buildPromoterShellCommand(jobName: string): string {
  return `kubectl exec -n ${k8sNamespace()} ${execTarget(jobName)} -- `
    + `${promoterExecCommand()} >/dev/null 2>&1 || true`
}
