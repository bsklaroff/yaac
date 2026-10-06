import fs from 'node:fs/promises'
import path from 'node:path'
import { claudeDir, projectDir, repoDir, workspacesDir } from '@yaac/shared/project-paths'
import { dropProjectClaudeKeychainItem } from '@yaac/shared/tool-auth'
import { applyWorkspaceEvent, listProjectRows } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { claudeProjectDirName } from '#runtime/agents'
import { harvestToolCredentials } from '#domain/auth'
import { serverLog } from '#log'

/*
 * Moves each project's data dir from `projects/<name>/` to `projects/<id>/`
 * for an install whose dirs were named by project slug, which the
 * `key_projects_by_id` migration kept as the project's `name`. A legacy-compat
 * step: see docs/legacy-compat-shims.md.
 */

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}

/**
 * Move every slug-named project dir to its id. A dir holding the project's
 * main clone is the project's tree: its running workspaces mount and hold
 * paths inside it, so they are stopped first (their rows and conversations
 * stay, so each can be restarted and resume), and a project whose
 * workspaces cannot be confirmed stopped keeps its old dir until the next
 * start. A dir without a main clone holds only what something wrote there
 * after an earlier move. Either way the dir is merged into `projects/<id>/`,
 * which a request may already have created.
 *
 * Runs before the runtime's watches start (`DriverSinks.recover`), after
 * the driver has loaded the workspaces it holds.
 */
export async function moveProjectDirsToIds(): Promise<void> {
  // Names are not unique once projects are keyed by id; a dir named after
  // one belongs to the oldest project of that name, which predates the move.
  const legacy = []
  const rows = (await listProjectRows()).sort((x, y) => x.addedAt.localeCompare(y.addedAt))
  for (const [i, row] of rows.entries()) {
    if (rows.findIndex((r) => r.name === row.name) !== i || row.name === row.id) continue
    if (await exists(projectDir(row.name))) legacy.push(row)
  }
  if (legacy.length === 0) return

  // A containerless workspace reports the project its dir is named after,
  // so its stop is recorded under the id and the runtime is handed back
  // what it reported.
  const trees = new Set<string>()
  for (const row of legacy) if (await exists(repoDir(row.name))) trees.add(row.id)
  const idOf = new Map(legacy.flatMap((r) => [[r.name, r.id], [r.id, r.id]]))
  const stuck = new Set<string>()
  const runtime = workspaceDriver()
  for (const h of trees.size > 0 ? await runtime.list() : []) {
    const projectId = idOf.get(h.projectId)
    if (projectId === undefined || !trees.has(projectId)) continue
    await applyWorkspaceEvent({ type: 'workspace-stopped', projectId, workspaceId: h.workspaceId })
    // Destroy first: a containerless runtime finds the processes to wait on
    // through the registry entry that deregistering forgets.
    const gone = await runtime.destroy({ projectId: h.projectId, workspaceId: h.workspaceId, unitName: h.jobName })
    await runtime.deregisterWorkspace(h.workspaceId)
    if (gone) {
      serverLog(`[server] stopped workspace ${h.workspaceId} to move its project dir`)
    } else {
      stuck.add(projectId)
      serverLog(`[server] workspace ${h.workspaceId} could not be confirmed stopped, so project `
        + `${projectId} keeps its old dir until the next start`)
    }
  }

  for (const row of legacy) {
    if (stuck.has(row.id)) continue
    try {
      await moveProjectDir(row.name, row.id)
      serverLog(`[server] moved project dir ${row.name} to ${row.id}`)
    } catch (err) {
      serverLog(`[server] moving project dir ${row.name} to ${row.id} failed: ${String(err)}`)
    }
  }
}

async function moveProjectDir(name: string, id: string): Promise<void> {
  // Adopt a token an agent refreshed in the old tool home (a no-op with a
  // proxy), and drop the macOS Keychain item claude keyed on its path.
  await harvestToolCredentials({ projectId: name })
    .catch((err: unknown) => serverLog(`[server] credential harvest for ${name} failed: ${String(err)}`))
  dropProjectClaudeKeychainItem(name)

  // Before the move, so a crash between the two leaves nothing to repair:
  // repoint each checkout's alternates at where the main clone is going (a
  // launch rewrites it, but a stopped workspace's diff is read before any
  // launch), and drop claude's history links named after the old checkout
  // paths, which would otherwise sit beside the new ones.
  const objects = path.join(repoDir(id), '.git', 'objects')
  for (const workspaceId of await fs.readdir(workspacesDir(name)).catch(() => [])) {
    const checkout = path.join(workspacesDir(name), workspaceId)
    const alternates = path.join(checkout, '.git', 'objects', 'info', 'alternates')
    if (await exists(alternates)) await fs.writeFile(alternates, `${objects}\n`)
    for (const form of new Set([checkout, await fs.realpath(checkout).catch(() => checkout)])) {
      const link = path.join(claudeDir(name), 'projects', claudeProjectDirName(form))
      if ((await fs.lstat(link).catch(() => null))?.isSymbolicLink() === true) await fs.unlink(link)
    }
  }

  await mergeDir(projectDir(name), projectDir(id))
}

/**
 * Move `from` to `to`, merging into what `to` already holds: an entry only
 * `from` has is moved in, and of a file both have the newer copy is kept.
 * `from` is removed.
 */
async function mergeDir(from: string, to: string): Promise<void> {
  if (!await exists(to)) {
    await fs.rename(from, to)
    return
  }
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    const there = await fs.lstat(dest).catch(() => null)
    if (entry.isDirectory() && there?.isDirectory() === true) {
      await mergeDir(src, dest)
    } else if (there === null || (await fs.lstat(src)).mtimeMs > there.mtimeMs) {
      await fs.rm(dest, { recursive: true, force: true })
      await fs.rename(src, dest)
    } else {
      serverLog(`[server] project dir move: kept the newer ${dest} over ${src}`)
    }
  }
  await fs.rm(from, { recursive: true, force: true })
}
