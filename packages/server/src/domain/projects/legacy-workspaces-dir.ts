import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir, workspacesDir } from '@yaac/shared/project-paths'
import { serverLog } from '#log'

/**
 * Move each project's legacy `worktrees/` dir to `workspaces/`, leaving
 * `worktrees` as a relative link so workspaces launched before the upgrade
 * keep working: their mounts, cwd, marker paths and git admin dirs use the
 * old path (docs/legacy-compat-shims.md).
 *
 * The link is created beside the dir and renamed into place last, so a start
 * that dies partway never leaves a moved dir without its link. A project that
 * can't be moved is logged and skipped.
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
