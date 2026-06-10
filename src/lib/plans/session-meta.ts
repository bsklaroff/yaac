import fs from 'node:fs/promises'
import path from 'node:path'
import { projectDir } from '@/lib/project/paths'
import type { PlanRole } from '@/shared/types'

export interface PlanSessionMeta {
  role: PlanRole
  /** Wiki page filename the session works on. */
  doc: string
}

/**
 * Host-side marker recording that a session is a plan-mode session and
 * which doc it owns. Container labels carry the same info while the
 * container lives; this file is what lets a restart re-mount /plans
 * after the container is gone.
 */
export function planSessionMetaFile(slug: string, sessionId: string): string {
  return path.join(projectDir(slug), 'sessions', sessionId, 'plans-meta.json')
}

export async function savePlanSessionMeta(
  slug: string,
  sessionId: string,
  meta: PlanSessionMeta,
): Promise<void> {
  const file = planSessionMetaFile(slug, sessionId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(meta, null, 2) + '\n')
}

export async function loadPlanSessionMeta(
  slug: string,
  sessionId: string,
): Promise<PlanSessionMeta | null> {
  try {
    const raw = await fs.readFile(planSessionMetaFile(slug, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PlanSessionMeta>
    if ((parsed.role === 'plan' || parsed.role === 'build') && typeof parsed.doc === 'string') {
      return { role: parsed.role, doc: parsed.doc }
    }
    return null
  } catch {
    return null
  }
}
