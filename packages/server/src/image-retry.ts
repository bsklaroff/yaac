/**
 * Explicit retry of a finished image build, driving the webapp's "Retry"
 * action. Dismissing a failed row only hides it (and keeps backing off the
 * prewarm sweep); retry is the deliberate "rebuild now" path.
 *
 * It forgets the tracked entry — so its failure stops gating
 * `hasBlockingFailure` — then re-triggers the build the row stood for: the
 * owning project's chain (via the prewarm path, which the coordinator
 * single-flights and de-dups against any in-flight build), or the shared
 * proxy sidecar for an infrastructure build with no owning project. The
 * rebuild registers its own fresh entry, so the "building" row reappears.
 */
import { forgetImageBuild, getImageBuild } from '#image-builds'
import { prewarmProjectImage } from '#image-prewarm'
import { proxyClient } from '#lib/container/proxy-client'
import { serverLog } from '#log'

/**
 * Retry the build a tracked entry stands for. Returns false when the id is
 * unknown or still running (nothing to retry); otherwise forgets the entry
 * and fires the rebuild in the background, returning true. Fire-and-forget:
 * the rebuild owns its own registry entry and error logging.
 */
export function retryImageBuild(id: string): boolean {
  const entry = getImageBuild(id)
  if (!entry || entry.status === 'running') return false
  forgetImageBuild(id)

  if (entry.projectSlugs.length > 0) {
    for (const slug of entry.projectSlugs) {
      void prewarmProjectImage(slug).catch((err: unknown) =>
        serverLog(`[image-retry] ${slug}: ${String(err)}`))
    }
  } else {
    // No owning project: the shared proxy sidecar. Re-running ensureRunning
    // rebuilds its image when the tag is missing (which a failed build left).
    void proxyClient.ensureRunning().catch((err: unknown) =>
      serverLog(`[image-retry] proxy: ${String(err)}`))
  }
  return true
}
