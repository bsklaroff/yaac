import { containerExec } from '#lib/k8s/exec'
import {
  dataDirHash,
  execFileAsync,
  k8sNamespace,
  kubectlApply,
  kubectlWithRetry,
} from '#lib/k8s/kubectl'
import { LABEL_DATA_DIR_HASH } from '#lib/k8s/pods'
import {
  SHARED_IMAGE_STORE_DST_PATH,
  SHARED_IMAGE_STORE_PATH,
} from '#lib/k8s/pod-spec'
import { pushImageToRegistry, registryHasTag, registryRef } from '#lib/k8s/registry'
import { imageExists } from '#lib/container/runtime'
import { testEnv } from '@yaac/shared/env'
import { shellQuote } from '#lib/shell'
import { serverLog } from '#log'

/**
 * Salvage a nested session's built/pulled images into the project's
 * cross-session shared image store before (or while) the pod exists.
 *
 * WHY THIS SHAPE (measured, 2026-07): the naive approach — skopeo
 * copying graphroot → store INSIDE the session sandbox — extracts every
 * layer file-by-file through the gVisor gofer at ~2ms/file; a
 * node_modules-heavy image chain is >100k files, so a 4GB salvage took
 * 16+ minutes and blocked session termination the whole time. The
 * upstream-intended pattern for populating an `additionalimagestores`
 * lower is a NATIVE-side `podman --root <store> load` (writable
 * additional stores were requested and declined, containers/storage
 * #1733). So the pipeline splits at the sandbox boundary:
 *
 *   1. IN-POD (one exec, sudo-gated): survey the engine's images, diff
 *      against the store (readable in-pod via the read-only
 *      additional-store mount), and `podman save` the missing ones as a
 *      single multi-image tar INTO the store directory — a bulk
 *      sequential gofer write (~70MB/s), not a per-file storm. Tar
 *      streaming out of the sentry is near-native.
 *   2. NODE-SIDE (a one-shot runc "writer" pod on a pinned
 *      quay.io/podman/stable image, hostPath-mounting the store):
 *      `podman --root /store load` extracts at native speed, restores
 *      tags, prunes stale dangling images, and removes the tar — all
 *      under a real host flock (possible again now that the lock holder
 *      is not inside a sentry; the old cross-pod mkdir-lock hack is
 *      gone with the in-sentry promoter).
 *
 * The writer runs yaac-shipped commands on a digest-pinned upstream
 * image — NEVER the session's image, whose binaries are
 * user-customizable and must not execute as root outside the sandbox.
 *
 * Self-gating: non-nested session pods have neither the store mounts
 * nor a podman binary, so step 1 reports nothing and the salvage is a
 * single cheap exec.
 */

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
 * Digest-pinned upstream image the salvage writer pod runs — podman +
 * coreutils, mirrored into the local registry like the vcluster image
 * set (the digest IS the pin; no content-hash tag). Pinned near the
 * session engines' podman major so store metadata stays compatible.
 */
export const SALVAGE_WRITER_UPSTREAM =
  'quay.io/podman/stable@sha256:25d49cf990843962043942db172c7ef5c6f85012384aada7976aec65906ae209'
export const SALVAGE_WRITER_LOCAL_TAG = 'podman-stable:v5.5'

/** yaac.role value marking salvage-writer pods (sweepable by label). */
export const ROLE_SALVAGE_WRITER = 'salvage-writer'

/** In-writer mount point of the store hostPath. */
const WRITER_STORE_PATH = '/store'

/**
 * Tagged generations kept per store repository. Content-hash rebuilds
 * re-tag under the same repo (`yaac-base:<hash>`), and a tagged image
 * pins its whole intermediate layer chain — without retirement the store
 * grows ~3–4GB per rebuild, forever (measured 25GB after one day of e2e
 * churn). Two generations cover current + one rollback/in-flight.
 */
export const STORE_GENERATIONS_KEPT = 2

/**
 * Age floor for the dangling prune. Retirement only untags; the space
 * lives in the retired generations' now-dangling chains, which this
 * prune cascades away. The floor exists for mid-build salvages: a chain
 * salvaged from an in-progress build has a dangling head until a later
 * salvage adds its children/tag, and builds run ~10–25min — 2h keeps
 * such chains safely out of reach without retaining a week of churn.
 */
export const STORE_PRUNE_UNTIL = '2h'

/** Host flock file serializing store writers (real kernel locks — the
 *  writer is a runc pod). Lives inside the store dir it guards. */
const STORE_LOCK_FILE = `${WRITER_STORE_PATH}/.yaac-salvage.lock`

/** Tar handoff file the in-pod save writes and the writer consumes,
 *  named per session so concurrent salvages never collide. */
export function salvageTarName(sessionId: string): string {
  return `.salvage-${sessionId}.tar`
}

/** Writer pod name for one session's salvage run. */
export function salvageWriterPodName(sessionId: string): string {
  return `yaac-salvage-${sessionId.slice(0, 8)}`
}

const IMAGE_ID = /^[0-9a-f]{64}$/
// Conservative image-ref shape (registry/repo:tag). Refs come from the
// session engine — agent-influenced — so anything outside this set is
// dropped rather than quoted into the writer's tag command.
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/

export interface EngineImageRow {
  id: string
  /** repo:tag, or null for dangling (`<none>:<none>`) images. */
  ref: string | null
}

/**
 * Parse the survey report the in-pod script prints: `img <id>[ <ref>]`
 * rows plus a final `saved <n>`. Unknown lines (podman warnings on
 * stderr never reach us, but be lenient) are ignored; malformed ids and
 * refs are dropped here so nothing unvalidated reaches the writer.
 */
export function parseSurveyReport(stdout: string): { images: EngineImageRow[]; savedCount: number } {
  const images: EngineImageRow[] = []
  let savedCount = 0
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] === 'img' && parts[1]) {
      const id = parts[1].replace(/^sha256:/, '')
      if (!IMAGE_ID.test(id)) continue
      const ref = parts[2] && parts[2] !== '<none>:<none>' && IMAGE_REF.test(parts[2]) ? parts[2] : null
      images.push({ id, ref })
    } else if (parts[0] === 'saved' && parts[1]) {
      savedCount = Number(parts[1]) || 0
    }
  }
  return { images, savedCount }
}

/**
 * The in-pod survey+export script (step 1), run as root via the image's
 * passwordless sudo (the engine is rootful). Prints the report
 * `parseSurveyReport` consumes. Diffs against the store through the
 * read-only additional-store mount — no writer pod is spawned when
 * there is nothing to do.
 */
export function buildSurveyScript(sessionId: string): string {
  const tar = `${SHARED_IMAGE_STORE_DST_PATH}/${salvageTarName(sessionId)}`
  return [
    'set -u',
    `[ -d ${SHARED_IMAGE_STORE_DST_PATH} ] || exit 0`,
    'command -v podman >/dev/null 2>&1 || exit 0',
    `rows=$(podman image ls -a --no-trunc --format '{{.ID}}|{{.Repository}}:{{.Tag}}' 2>/dev/null || true)`,
    '[ -n "$rows" ] || exit 0',
    // Store ids: the overlay-images dir has one dir per image id (plus
    // images.json / images.lock metadata files). Space-joined so the
    // `case` word-match below works (ls emits newlines).
    `store=$(ls ${SHARED_IMAGE_STORE_PATH}/overlay-images 2>/dev/null | grep -v "^images\\." | tr "\\n" " " || true)`,
    'missing=""',
    'echo "$rows" | sort -u | while IFS="|" read -r id ref; do',
    '  echo "img ${id#sha256:} $ref"',
    'done',
    'for id in $(echo "$rows" | cut -d"|" -f1 | sed "s/^sha256://" | sort -u); do',
    '  case " $store " in *" $id "*) ;; *) missing="$missing $id";; esac',
    'done',
    'if [ -n "$missing" ]; then',
    // shellcheck disable=SC2086 — word splitting of $missing is the point.
    `  podman save --multi-image-archive -o ${tar}.partial $missing >/dev/null 2>&1`
    + ` && mv ${tar}.partial ${tar}`
    + ' && echo "saved $(echo $missing | wc -w)"'
    + ` || { rm -f ${tar}.partial; echo "saved 0"; }`,
    'else',
    '  echo "saved 0"',
    'fi',
  ].join('\n')
}

/** The full in-pod exec command: gate on usable passwordless sudo, then
 *  run the survey script as root. Non-sudo images no-op quietly. */
export function surveyExecCommand(sessionId: string): string {
  const sudoRun = `exec sudo -n -H sh -c ${shellQuote(buildSurveyScript(sessionId))}`
  return `sh -c ${shellQuote(
    'command -v sudo >/dev/null 2>&1 || exit 0; '
    + `sudo -n true 2>/dev/null || exit 0; ${sudoRun}`,
  )}`
}

/**
 * Writer pod manifest: runc (no runtimeClassName — trusted infra, and
 * native file ops are the whole point), root, no added caps (`podman
 * load` applies layer diffs without mounting), store hostPath at
 * /store, parked on `sleep` so the server can exec the load step.
 * activeDeadlineSeconds bounds a leaked pod; the label makes leftovers
 * sweepable.
 */
export function buildSalvageWriterPodManifest(
  projectSlug: string,
  sessionId: string,
  imageRef: string,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: salvageWriterPodName(sessionId),
      namespace: k8sNamespace(),
      labels: {
        [LABEL_DATA_DIR_HASH]: dataDirHash(),
        'yaac.role': ROLE_SALVAGE_WRITER,
      },
    },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: 1800,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [{
        name: 'writer',
        image: imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: ['sleep', 'infinity'],
        volumeMounts: [{ name: 'store', mountPath: WRITER_STORE_PATH }],
      }],
      volumes: [{
        name: 'store',
        hostPath: { path: sharedImageStoreHostPath(projectSlug), type: 'DirectoryOrCreate' },
      }],
    },
  }
}

/**
 * The writer-side script: load the session's tar into the store, restore
 * tags for ids already present (a rebuilt tag re-points to an existing
 * id without a new save), run the store's GC, and sweep stale handoff
 * tars from crashed salvages. All under one host flock so concurrent
 * writers serialize.
 *
 * The GC is generation retention: keep the newest STORE_GENERATIONS_KEPT
 * tags per repository (untag the rest — podman removes the image only
 * when its last name goes), then prune dangling images past the
 * STORE_PRUNE_UNTIL floor. Retirement is what un-pins an old
 * generation's intermediate chain; the prune is what cascades it away.
 * Intermediates of kept generations have tagged descendants, so they are
 * never dangling and the cross-session build cache survives.
 *
 * Tag pairs arrive as argv (`id ref` alternating) — validated by the
 * caller against IMAGE_ID / IMAGE_REF, never interpolated into the
 * script text.
 */
export function buildWriterScript(sessionId: string): string {
  const tar = `${WRITER_STORE_PATH}/${salvageTarName(sessionId)}`
  const p = `podman --root ${WRITER_STORE_PATH} --runroot /tmp/dst-run`
  return [
    'set -u',
    'mkdir -p /tmp/dst-run',
    `if [ -f ${tar} ]; then`,
    `  ${p} load -i ${tar} >/dev/null 2>&1 || echo "load failed" >&2`,
    `  rm -f ${tar}`,
    'fi',
    'while [ "$#" -ge 2 ]; do',
    `  ${p} image exists "$1" 2>/dev/null && ${p} tag "$1" "$2" 2>/dev/null || true`,
    '  shift 2',
    'done',
    // --sort created lists newest first, so rows past the per-repo
    // budget are the stale generations. Dangling rows list as <none>.
    `${p} image ls --sort created --format '{{.Repository}} {{.Repository}}:{{.Tag}}' 2>/dev/null`
    + ` | awk -v keep=${STORE_GENERATIONS_KEPT} '$1 != "<none>" && ++seen[$1] > keep { print $2 }'`
    + ` | while IFS= read -r stale; do ${p} rmi "$stale" >/dev/null 2>&1 || true; done`,
    `${p} image prune --filter dangling=true --filter until=${STORE_PRUNE_UNTIL} -f >/dev/null 2>&1 || true`,
    // Crashed-salvage residue: partial/orphaned tars older than an hour.
    `find ${WRITER_STORE_PATH} -maxdepth 1 -name ".salvage-*.tar*" -mmin +60 -delete 2>/dev/null || true`,
    `echo "store-images $(${p} image ls -aq 2>/dev/null | wc -l | tr -d " ")"`,
  ].join('\n')
}

/** Ensure the pinned writer image is present in the local registry,
 *  mirroring it from upstream on first use (same convention as
 *  ensureVclusterImages — the digest is the pin). */
export async function ensureSalvageWriterImage(
  requirePrebuilt = testEnv.requirePrebuiltImages,
): Promise<string> {
  if (!await registryHasTag(SALVAGE_WRITER_LOCAL_TAG)) {
    if (!await imageExists(SALVAGE_WRITER_LOCAL_TAG)) {
      if (requirePrebuilt) {
        throw new Error(
          `salvage writer image ${SALVAGE_WRITER_LOCAL_TAG} is missing. `
          + 'Restart the test run so the global setup can mirror it.',
        )
      }
      await execFileAsync('podman', ['pull', SALVAGE_WRITER_UPSTREAM], { timeout: 600_000 })
      await execFileAsync('podman', ['tag', SALVAGE_WRITER_UPSTREAM, SALVAGE_WRITER_LOCAL_TAG])
    }
    await pushImageToRegistry(SALVAGE_WRITER_LOCAL_TAG)
  }
  return registryRef(SALVAGE_WRITER_LOCAL_TAG)
}

/** Per-session in-flight guard so the background promoter and a
 *  teardown never run two salvages (and two writer pods with the same
 *  name) concurrently. */
const salvageInflight = new Map<string, Promise<boolean>>()

export interface SalvageOptions {
  /** Deadline for the in-pod survey+save exec. Default 300s — the save
   *  is a bulk write of up to a few GB at ~70MB/s. */
  surveyTimeoutMs?: number
  /** Deadline for the writer's load+tag+prune exec. Default 300s. */
  writerTimeoutMs?: number
}

/**
 * Run one salvage for a session: survey in-pod, hand off via tar, load
 * node-side. Best-effort like the old promoter: any failure is logged
 * and swallowed — teardown must never be blocked on cache salvage.
 * Returns true when the salvage ran cleanly (including the no-op
 * cases). Concurrent calls for the same session coalesce.
 */
export async function salvageSessionImages(params: {
  jobName: string
  projectSlug: string
  sessionId: string
  opts?: SalvageOptions
}): Promise<boolean> {
  const { sessionId } = params
  const existing = salvageInflight.get(sessionId)
  if (existing) return existing
  const run = salvageSessionImagesUncoalesced(params).finally(() => {
    salvageInflight.delete(sessionId)
  })
  salvageInflight.set(sessionId, run)
  return run
}

async function salvageSessionImagesUncoalesced(params: {
  jobName: string
  projectSlug: string
  sessionId: string
  opts?: SalvageOptions
}): Promise<boolean> {
  const { jobName, projectSlug, sessionId, opts } = params
  const surveyTimeoutMs = opts?.surveyTimeoutMs ?? 300_000
  const writerTimeoutMs = opts?.writerTimeoutMs ?? 300_000

  // Step 1 — in-pod survey + tar export. Self-gates to a no-op for
  // non-nested sessions (no store mount / no podman / no sudo).
  let report: { images: EngineImageRow[]; savedCount: number }
  try {
    const { stdout } = await containerExec(jobName, surveyExecCommand(sessionId), {
      timeout: surveyTimeoutMs,
      maxAttempts: 1,
    })
    report = parseSurveyReport(stdout)
  } catch (err) {
    console.warn(`Image salvage survey for ${jobName} failed: ${(err as Error).message}`)
    return false
  }
  if (report.images.length === 0) return true
  const tagPairs = report.images.filter((r): r is { id: string; ref: string } => r.ref !== null)
  if (report.savedCount === 0 && tagPairs.length === 0) return true

  // Step 2 — node-side writer: load the tar, restore tags, prune.
  const podName = salvageWriterPodName(sessionId)
  try {
    const imageRef = await ensureSalvageWriterImage()
    // A leftover writer from a crashed salvage would shadow this run —
    // clear it first (fast no-op in the common case).
    await kubectlWithRetry([
      'delete', 'pod', podName, '-n', k8sNamespace(),
      '--ignore-not-found', '--wait=true', '--timeout=60s',
    ])
    await kubectlApply(buildSalvageWriterPodManifest(projectSlug, sessionId, imageRef))
    await kubectlWithRetry([
      'wait', '-n', k8sNamespace(), '--for=condition=Ready', `pod/${podName}`,
      '--timeout=120s',
    ], { maxAttempts: 1, timeout: 130_000 })

    // -i: the writer script arrives on stdin (`sh -s` keeps argv free
    // for the validated tag pairs, passed as direct exec args — no
    // shell quoting layer anywhere).
    const { stdout } = await kubectlWithRetry([
      'exec', '-i', '-n', k8sNamespace(), `pod/${podName}`, '--',
      'flock', STORE_LOCK_FILE, 'sh', '-s', '--',
      ...tagPairs.flatMap(({ id, ref }) => [id, ref]),
    ], { timeout: writerTimeoutMs, maxAttempts: 1, input: buildWriterScript(sessionId) })
    serverLog(
      `[server] image salvage: session=${sessionId} saved=${report.savedCount} `
      + `tags=${tagPairs.length} ${stdout.trim()}`,
    )
    return true
  } catch (err) {
    console.warn(`Image salvage writer for ${jobName} failed: ${(err as Error).message}`)
    return false
  } finally {
    await kubectlWithRetry([
      'delete', 'pod', podName, '-n', k8sNamespace(), '--ignore-not-found', '--wait=false',
    ]).catch(() => { /* best-effort */ })
  }
}
