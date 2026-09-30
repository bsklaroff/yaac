import { listProjectRows, listProjectWorktreeIds } from '#db'
import { adoptLinkedCheckout, sanitizeMainClone } from '#domain/git'
import { worktreeDriver } from '#drivers/driver'
import { serverLog } from '#log'
import { repoDir, worktreeDir } from '@yaac/shared/project-paths'

/**
 * The startup sweep that finishes moving an older install's worktrees onto
 * clones (docs/legacy-compat-shims.md): every stopped worktree still holding
 * a linked checkout is converted, and a project left with none has its main
 * clone sanitized, after which no pod can write it. The launch path
 * converts a checkout it restarts; this is for the ones nobody restarts,
 * which would otherwise hold the sanitize up forever. Row-driven, like
 * every sweep: a checkout no row names is left alone.
 *
 * Per project and per worktree best-effort — one that will not convert
 * keeps its project unsanitized, and is tried again at the next start.
 */
export async function convertLinkedCheckouts(): Promise<void> {
  const running = new Set((await worktreeDriver().list()).map((h) => `${h.projectSlug}/${h.workspaceId}`))
  for (const { slug, remoteUrl } of await listProjectRows()) {
    try {
      const ids = await listProjectWorktreeIds(slug)
      for (const [id, spare] of ids) {
        if (spare || running.has(`${slug}/${id}`)) continue
        await adoptLinkedCheckout(repoDir(slug), worktreeDir(slug, id), id, remoteUrl, new Set(ids.keys())).catch((err: unknown) => {
          serverLog(`[git] converting ${slug}/${id} to a clone failed: ${String(err)}`)
        })
      }
      await sanitizeMainClone(repoDir(slug), remoteUrl, new Set(ids.keys()))
    } catch (err) {
      serverLog(`[git] converting ${slug}'s checkouts failed: ${String(err)}`)
    }
  }
}
