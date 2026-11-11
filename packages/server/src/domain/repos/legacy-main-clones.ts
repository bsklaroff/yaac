import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir } from '@yaac/shared/paths'
import {
  claudeDir,
  claudeMemoryDirName,
  LEGACY_CLAUDE_MEMORY_DIR,
  legacyRepoDir,
  repoDir,
} from '@yaac/shared/project-paths'
import { getProjectRow, getRepo } from '#db'
import { absorbClone } from '#domain/git'
import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#lib/log'
import { isUuid } from '#lib/uuid'

/**
 * Move what each project kept under its own dir while it had exactly one
 * repo to where a repo's things are kept (docs/legacy-compat-shims.md "Main
 * clones under the project dir", "Claude memory under `-repo`"). Run at
 * every server start; a no-op once no project dir holds a real `repo` dir
 * or a real `claude/projects/-repo`.
 *
 * - **The main clone.** A project whose repo carries its id has its clone
 *   renamed into place. Any other (a share, which now uses the main clone
 *   of the repo it was shared from) has its clone's objects copied into the
 *   one its project links, and is removed once none of the project's
 *   workspaces runs, since a pod started before the upgrade still mounts
 *   it.
 * - **Claude's memory**, renamed to the folder named for the repo.
 *
 * Each leaves a relative symlink at the old path: a checkout's alternates
 * file and a containerless workspace's memory link, made before the
 * upgrade, name it until the workspace restarts.
 */
export async function moveLegacyMainClones(): Promise<void> {
  const projectIds = (await fs.readdir(getProjectsDir()).catch(() => [])).filter(isUuid)
  // Renames first, so the clone a share is absorbed into is in place
  // whatever order the project dirs list in.
  for (const step of [renameOwn, absorbOther, moveMemory]) {
    for (const projectId of projectIds) {
      await step(projectId).catch((err: unknown) => {
        serverLog(`[git] moving what project ${projectId} kept for its repo: ${String(err)}`)
      })
    }
  }
}

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

const isRealDir = async (p: string): Promise<boolean> => (await fs.lstat(p).catch(() => null))?.isDirectory() === true

/** Leave `link` pointing at `target`, relative so it survives the data dir
 *  moving, unless something is already there. */
async function linkBehind(link: string, target: string): Promise<void> {
  if (await fs.lstat(link).catch(() => null) !== null) return
  await fs.symlink(path.relative(path.dirname(link), target), link)
}

async function renameOwn(projectId: string): Promise<void> {
  const own = repoDir(projectId)
  const legacy = legacyRepoDir(projectId)
  if (await isRealDir(legacy) && await getRepo(projectId) && !await exists(own)) {
    await fs.mkdir(path.dirname(own), { recursive: true })
    await fs.rename(legacy, own)
  }
  // Also for a start that died between the rename and the link.
  if (await exists(own)) await linkBehind(legacy, own)
}

async function absorbOther(projectId: string): Promise<void> {
  const legacy = legacyRepoDir(projectId)
  if (!await isRealDir(legacy)) return
  const [link] = (await getProjectRow(projectId))?.repos ?? []
  if (!link || link.repo.id === projectId) return
  if ((await workspaceDriver().list(projectId)).length > 0) return
  const into = repoDir(link.repo.id)
  if (!await exists(into)) return
  await absorbClone(into, legacy)
  await fs.rm(legacy, { recursive: true, force: true })
  await linkBehind(legacy, into)
}

/** The project's one memory becomes that of the repo it had: the one
 *  carrying its id, else (a share) the one it links. */
async function moveMemory(projectId: string): Promise<void> {
  const projects = path.join(claudeDir(projectId), 'projects')
  const legacy = path.join(projects, LEGACY_CLAUDE_MEMORY_DIR)
  if (!await isRealDir(legacy)) return
  const links = (await getProjectRow(projectId))?.repos ?? []
  const link = links.find((l) => l.repo.id === projectId) ?? links.at(0)
  if (!link) return
  const named = path.join(projects, claudeMemoryDirName(link.repo.id))
  if (await fs.lstat(named).catch(() => null) !== null) {
    serverLog(`[git] project ${projectId} has both ${legacy} and ${named}; the first is left unread`)
    return
  }
  await fs.rename(legacy, named)
  await linkBehind(legacy, named)
}
