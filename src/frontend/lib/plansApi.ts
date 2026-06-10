import { api } from './apiClient'
import { streamSessionOp } from './createSession'
import type { AgentTool, PlansResult } from '@/shared/types'

export interface PlanSessionResult {
  sessionId: string
  containerName: string
  tool: AgentTool
  /** Wiki page filename the session works on. */
  doc: string
}

export async function fetchPlans(slug: string): Promise<PlansResult> {
  return api.get(`/project/${encodeURIComponent(slug)}/plans`)
}

export async function fetchPlanDoc(
  slug: string,
  path: string,
): Promise<{ content: string; draftSessionId: string | null }> {
  return api.get(
    `/project/${encodeURIComponent(slug)}/plans/doc?path=${encodeURIComponent(path)}`,
  )
}

/** Spawn a grill (planning) session for a topic; streams progress. */
export async function newPlan(
  slug: string,
  topic: string,
  onProgress: (message: string) => void,
): Promise<PlanSessionResult> {
  return await streamSessionOp(
    `/project/${encodeURIComponent(slug)}/plans/new`, { topic }, onProgress,
  ) as PlanSessionResult
}

/** Resume planning on an existing doc: spawns a grill session seeded to
 *  read the doc and continue the interview. */
export async function continuePlan(
  slug: string,
  path: string,
  onProgress: (message: string) => void,
): Promise<PlanSessionResult> {
  return await streamSessionOp(
    `/project/${encodeURIComponent(slug)}/plans/continue`, { path }, onProgress,
  ) as PlanSessionResult
}

/** Promote a plan doc to Build: frontmatter flip + seeded build session. */
export async function promotePlan(
  slug: string,
  path: string,
  onProgress: (message: string) => void,
): Promise<PlanSessionResult> {
  return await streamSessionOp(
    `/project/${encodeURIComponent(slug)}/plans/promote`, { path }, onProgress,
  ) as PlanSessionResult
}
