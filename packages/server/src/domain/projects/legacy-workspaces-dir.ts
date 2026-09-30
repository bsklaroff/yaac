import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir, workspacesDir } from '@yaac/shared/project-paths'
import { serverLog } from '#log'

/**
 * Move each project's checkouts from `worktrees/`, where an install from
 * before workspaces were named keeps them, to `workspaces/`, leaving
 * `worktrees` as a relative link to the new dir. The link is what keeps a
 * workspace launched before the upgrade working: its pod's mount, its cwd,
 * its recorded marker paths and the linked checkouts' git admin dirs all
 * spell the old path (docs/legacy-compat-shims.md).
 *
 * The link is made first, beside the dir, and renamed into place last, so
 * a start that dies partway leaves either the dir (redone from scratch) or
 * the waiting link (moved in) — never a moved dir with no link. A project
 * it cannot move is logged and left, not fatal to the start.
 */
export async function moveLegacyWorkspacesDirs(): Promise<void> {
  const root = getProjectsDir()
  for (const slug of await fs.readdir(root).catch(() => [])) {
    const legacy = path.join(root, slug, 'worktrees')
    const link = `${legacy}.link`
    try {
      if ((await fs.lstat(legacy).catch(() => null))?.isDirectory()) {
        await fs.rm(link, { force: true })
        await fs.symlink('workspaces', link)
        await fs.rename(legacy, workspacesDir(slug))
      }
      if (await fs.lstat(link).then(() => true, () => false)) await fs.rename(link, legacy)
    } catch (err) {
      serverLog(`[server] could not move ${legacy} to workspaces/: ${String(err)}`)
    }
  }
}
