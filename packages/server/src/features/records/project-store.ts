import fs from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb, projects } from '#platform/db'
import { getProjectsDir } from '@yaac/shared/project-paths'
import type { ProjectMeta } from '@yaac/shared/types'

/**
 * Which projects exist, as the server records them.
 *
 * The clone, the config and the tool homes are the substrate's bytes; this is
 * the metadata, so that answering "which projects are there" never depends on
 * a filesystem the server may not share (docs/plans/herd-split.md).
 */
export async function recordProject(meta: ProjectMeta): Promise<void> {
  const db = await getDb()
  await db.insert(projects).values(meta).onConflictDoUpdate({
    target: projects.slug,
    set: { remoteUrl: meta.remoteUrl },
  })
}

export async function getProjectRow(slug: string): Promise<ProjectMeta | undefined> {
  await adoptProjectDirs()
  const db = await getDb()
  const rows = await db.select().from(projects).where(eq(projects.slug, slug))
  return rows[0]
}

export async function listProjectRows(): Promise<ProjectMeta[]> {
  await adoptProjectDirs()
  const db = await getDb()
  return db.select().from(projects)
}

export async function deleteProjectRow(slug: string): Promise<void> {
  const db = await getDb()
  await db.delete(projects).where(eq(projects.slug, slug))
}

/**
 * Turn a `project.json` with no row into a row on sight — the last code that
 * enumerates the projects directory, and the reason an existing install does
 * not lose its projects the first time it runs a yaac that reads rows.
 *
 * Deliberately NOT one-shot. A durable "already migrated" flag would make a
 * directory that appears *after* the first read invisible forever, and there
 * is no window in which that cannot happen — a second yaac writing into the
 * same data dir, a restored backup, a manual copy. Re-adoption cannot
 * resurrect a removed project either, because removal takes the directory
 * with it.
 *
 * It dies when the substrate stops sharing the server's filesystem, at which
 * point every project arrived through `recordProject`.
 */
async function adoptProjectDirs(): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(getProjectsDir())
  } catch {
    return // no projects directory: nothing to adopt
  }
  const db = await getDb()
  const known = new Set((await db.select({ slug: projects.slug }).from(projects))
    .map((r) => r.slug))
  for (const entry of entries) {
    if (known.has(entry)) continue
    let meta: ProjectMeta
    try {
      meta = JSON.parse(
        await fs.readFile(path.join(getProjectsDir(), entry, 'project.json'), 'utf8'),
      ) as ProjectMeta
    } catch {
      continue // not a project directory, or malformed — skip it
    }
    if (typeof meta.slug !== 'string' || typeof meta.remoteUrl !== 'string') continue
    // The directory name IS the slug — every path yaac builds for a project
    // comes from `projectDir(slug)`. A file claiming a different one does not
    // describe this directory, and adopting it would both point a row at
    // bytes that are elsewhere and, because the dedupe key above is the
    // directory name, re-record it on every read — overwriting the real row's
    // remote on each pass.
    if (meta.slug !== entry) continue
    await recordProject({
      slug: meta.slug,
      remoteUrl: meta.remoteUrl,
      addedAt: meta.addedAt ?? new Date().toISOString(),
    })
  }
}
