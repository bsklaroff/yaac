import { execFileAsync } from '#drivers/k8s/container'

/**
 * GC of the host podman image store, run by `yaac cluster install` (the
 * only command that builds on the host engine). Each rebuild adds a new
 * content-hash tag to the same repo, and each tag pins its layer chain, so
 * old generations pile up. This keeps the newest HOST_GENERATIONS_KEPT tags
 * per yaac repo, untags the rest, then prunes dangling images. Layers of
 * kept tags are never dangling, so the build cache survives.
 *
 * Digest-pinned upstream mirrors are never touched. Neither are the e2e
 * suite's `yaac-test-*` images, which another test rig on the same engine
 * may be building; the suite retires those itself
 * (`@yaac/test-utils/test-images`). See docs/image-gc.md.
 */

/** Tagged generations kept per repo: the current one plus one more. */
export const HOST_GENERATIONS_KEPT = 2

/** Minimum age for the dangling prune, so it never removes the fresh
 *  intermediate layers of a build still in progress. */
export const HOST_PRUNE_UNTIL = '24h'

/** Repos yaac builds or stages for a registry push, excluding the e2e
 *  suite's `yaac-test-*`. */
const YAAC_IMAGE_REPO = /^(localhost(:\d+)?\/)?yaac-(?!test-)/

interface ImageLsRow {
  repo: string
  /** repo:tag */
  ref: string
}

/** Parse `podman image ls --format '{{.Repository}}|{{.Repository}}:{{.Tag}}'`
 *  output, dropping dangling (`<none>`) and malformed rows. */
function parseImageLsRows(stdout: string): ImageLsRow[] {
  const rows: ImageLsRow[] = []
  for (const line of stdout.split('\n')) {
    const [repo, ref] = line.trim().split('|')
    if (!repo || !ref || repo === '<none>') continue
    rows.push({ repo, ref })
  }
  return rows
}

/**
 * The tags to retire: in each repo matching `repoPattern`, everything past
 * the newest `keep` (rows arrive newest first). Tags in `protect`, bare or
 * `localhost/`-qualified, are skipped and don't count toward `keep`.
 */
function selectStaleGenerationTags(
  rows: ImageLsRow[],
  repoPattern: RegExp,
  keep: number,
  protect: ReadonlySet<string> = new Set(),
): string[] {
  const seen = new Map<string, number>()
  const stale: string[] = []
  for (const { repo, ref } of rows) {
    if (!repoPattern.test(repo)) continue
    if (protect.has(ref) || protect.has(ref.replace(/^localhost\//, ''))) continue
    const n = (seen.get(repo) ?? 0) + 1
    seen.set(repo, n)
    if (n > keep) stale.push(ref)
  }
  return stale
}

/**
 * Untag every generation past the newest `keep` in each repo matching
 * `repoPattern`, sparing `protect`. Uses `rmi` without `-f`, so an image in
 * use fails and is left for the next sweep. Returns the tags retired.
 */
export async function retireStaleGenerations(
  repoPattern: RegExp,
  protect: ReadonlySet<string> = new Set(),
  keep = HOST_GENERATIONS_KEPT,
): Promise<string[]> {
  const { stdout } = await execFileAsync('podman', [
    'image', 'ls', '--sort', 'created',
    '--format', '{{.Repository}}|{{.Repository}}:{{.Tag}}',
  ])
  const retired: string[] = []
  for (const ref of selectStaleGenerationTags(parseImageLsRows(stdout), repoPattern, keep, protect)) {
    try {
      await execFileAsync('podman', ['rmi', ref])
      retired.push(ref)
    } catch {
    }
  }
  return retired
}

/**
 * One GC pass over the host engine: retire stale generation tags of the
 * yaac-built repos, then prune dangling images past the age floor. Returns
 * what was done for the log line.
 */
export async function gcHostImages(): Promise<{ retired: string[]; pruned: number }> {
  const retired = await retireStaleGenerations(YAAC_IMAGE_REPO)
  const { stdout: pruneOut } = await execFileAsync('podman', [
    'image', 'prune', '-f', '--filter', `until=${HOST_PRUNE_UNTIL}`,
  ])
  const pruned = pruneOut.split('\n').filter((l) => /^[0-9a-f]{12,}$/.test(l.trim())).length
  return { retired, pruned }
}
