import { execFileAsync } from '#drivers/k8s/container'

/**
 * GC of the host podman engine's image store, run by `yaac cluster
 * install` — the one command that still builds on this engine. Every
 * content-hash rebuild re-tags under the same
 * repository (`yaac-base:<hash>`, `yaac-user-<slug>:<hash>`, …) and each
 * tag pins its whole intermediate layer chain, so the engine accumulates
 * generations without bound (measured: 23 yaac-base tags, ~14GB
 * reclaimable). Policy: keep the newest HOST_GENERATIONS_KEPT tags per
 * yaac-built repository, untag the rest, then prune dangling images —
 * retirement un-pins an old generation's chain, the prune cascades it
 * away. Intermediates of kept generations have tagged descendants, so
 * they are never dangling and the podman build cache survives.
 *
 * Scoped to repos yaac builds or stages (YAAC_IMAGE_REPO): digest-pinned
 * upstream mirrors (registry, podman/stable, envoy) are
 * single-tag and must never be touched.
 *
 * Sweeping at install time rather than on a server tick is what keeps it
 * honest about generations still in use: the registry, not this store, is
 * where a running cluster resolves images, and the process doing the
 * retiring is the same one that just rebuilt what it wants to keep.
 */

/** Tagged generations kept per repo: current + one rollback/in-flight. */
export const HOST_GENERATIONS_KEPT = 2

/**
 * Age floor for the dangling prune, so it can never touch an in-flight
 * `podman build`'s freshly committed intermediates. Retired generations'
 * chains are weeks old and go immediately; host churn is slow enough
 * (unlike the shared store's) that a day of extra retention is cheap.
 */
export const HOST_PRUNE_UNTIL = '24h'

/**
 * Repos yaac builds (`yaac-base`, `yaac-tools`, `yaac-user-<slug>`,
 * `yaac-test-*`, …) or stages for a registry push (`localhost:<port>/…`).
 */
const YAAC_IMAGE_REPO = /^(localhost(:\d+)?\/)?yaac-/

export interface ImageLsRow {
  repo: string
  /** repo:tag */
  ref: string
}

/** Parse `podman image ls --format '{{.Repository}}|{{.Repository}}:{{.Tag}}'`
 *  output, dropping dangling (`<none>`) and malformed rows. */
export function parseImageLsRows(stdout: string): ImageLsRow[] {
  const rows: ImageLsRow[] = []
  for (const line of stdout.split('\n')) {
    const [repo, ref] = line.trim().split('|')
    if (!repo || !ref || repo === '<none>') continue
    rows.push({ repo, ref })
  }
  return rows
}

/**
 * The tags to retire: rows arrive newest-first (`--sort created`), so
 * everything past the per-repo budget in a yaac-built repo is a stale
 * generation. Non-yaac repos are never candidates.
 */
export function selectStaleGenerationTags(
  rows: ImageLsRow[],
  keep = HOST_GENERATIONS_KEPT,
): string[] {
  const seen = new Map<string, number>()
  const stale: string[] = []
  for (const { repo, ref } of rows) {
    if (!YAAC_IMAGE_REPO.test(repo)) continue
    const n = (seen.get(repo) ?? 0) + 1
    seen.set(repo, n)
    if (n > keep) stale.push(ref)
  }
  return stale
}

/**
 * One GC pass over the host engine: retire stale generation tags (no
 * `-f` — a tag whose image is in use by a container, or mid-build as a
 * FROM, fails its rmi and is retried next sweep), then prune dangling
 * images past the age floor. Returns what was done for the log line.
 */
export async function gcHostImages(): Promise<{ retired: string[]; pruned: number }> {
  const { stdout } = await execFileAsync('podman', [
    'image', 'ls', '--sort', 'created',
    '--format', '{{.Repository}}|{{.Repository}}:{{.Tag}}',
  ])
  const stale = selectStaleGenerationTags(parseImageLsRows(stdout))
  const retired: string[] = []
  for (const ref of stale) {
    try {
      await execFileAsync('podman', ['rmi', ref])
      retired.push(ref)
    } catch {
      // in use or raced by a concurrent rmi — leave it for the next sweep
    }
  }
  const { stdout: pruneOut } = await execFileAsync('podman', [
    'image', 'prune', '-f', '--filter', `until=${HOST_PRUNE_UNTIL}`,
  ])
  const pruned = pruneOut.split('\n').filter((l) => /^[0-9a-f]{12,}$/.test(l.trim())).length
  return { retired, pruned }
}
