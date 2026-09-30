import { listProjectRows, listProjectWorkspaceIds } from '#db'
import { adoptLinkedCheckout, sanitizeMainClone } from '#domain/git'
import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#log'
import { repoDir, workspaceDir } from '@yaac/shared/project-paths'

/**
 * Startup sweep converting legacy linked checkouts to clones
 * (docs/legacy-compat-shims.md). Converts every stopped workspace's checkout
 * (restart converts the others), then sanitizes the project's main clone.
 * Only row-named checkouts are touched. Best-effort; a failure leaves the
 * project unsanitized until the next start.
 */
export async function convertLinkedCheckouts(): Promise<void> {
  const running = new Set((await workspaceDriver().list()).map((h) => `${h.projectSlug}/${h.workspaceId}`))
  for (const { slug, remoteUrl } of await listProjectRows()) {
    try {
      const ids = await listProjectWorkspaceIds(slug)
      for (const [id, spare] of ids) {
        if (spare || running.has(`${slug}/${id}`)) continue
        await adoptLinkedCheckout(repoDir(slug), workspaceDir(slug, id), id, remoteUrl, new Set(ids.keys())).catch((err: unknown) => {
          serverLog(`[git] converting ${slug}/${id} to a clone failed: ${String(err)}`)
        })
      }
      await sanitizeMainClone(repoDir(slug), remoteUrl, new Set(ids.keys()))
    } catch (err) {
      serverLog(`[git] converting ${slug}'s checkouts failed: ${String(err)}`)
    }
  }
}
