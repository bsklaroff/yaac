import { listProjectRows } from '#features/records'
import {
  isDeferredClusterBootPending,
  isPrewarmed,
  listSessionPods,
  triggerDeferredClusterBoot,
} from '#platform/k8s'

export interface ProjectListEntry {
  slug: string
  remoteUrl: string
  addedAt: string
  sessionCount: number
}

/**
 * Every recorded project, with a live session count by pod label. If the
 * cluster is unavailable we still return the projects — just with
 * `sessionCount: 0`, which is the whole point of the split: which projects
 * exist is the server's own record, and only the count needs a substrate.
 *
 * This is the pure data half of `yaac project list`; the CLI renderer
 * lives in `src/commands/project-list.ts`.
 */
export async function listProjects(): Promise<ProjectListEntry[]> {
  const [rows, sessionCounts] = await Promise.all([
    listProjectRows(),
    countSessionsByProject(),
  ])
  return rows.map((meta) => ({
    slug: meta.slug,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    sessionCount: sessionCounts[meta.slug] ?? 0,
  }))
}

async function countSessionsByProject(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  if (isDeferredClusterBootPending()) {
    // A nested server whose deferred cluster attach hasn't finished has
    // no session pods by construction, so every count is 0 — answer
    // instantly instead of holding the first snapshot (and with it the
    // web-app's project list) on a kubectl call to a still-waking
    // vcluster. Kick the attach so the caches come up and push a fresh
    // snapshot with real counts.
    triggerDeferredClusterBoot()
    return counts
  }
  try {
    const pods = await listSessionPods()
    for (const p of pods) {
      if (isPrewarmed(p)) continue // spares aren't user sessions
      if (p.projectSlug) counts[p.projectSlug] = (counts[p.projectSlug] ?? 0) + 1
    }
  } catch {
    // cluster not available — leave counts empty
  }
  return counts
}
