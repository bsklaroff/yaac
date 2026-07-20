import { api } from './api'
import type { AgentTool, ScheduleEntry } from '@yaac/shared/types'

/** All schedules, optionally scoped to one project. */
export async function listSchedules(project?: string): Promise<ScheduleEntry[]> {
  const { schedules } = await api.schedule.list.$get({ query: project ? { project } : {} })
  return schedules
}

/** Register a cron schedule that starts sessions with an initial prompt. */
export async function addSchedule(
  project: string,
  spec: string,
  prompt: string,
  tool?: AgentTool,
): Promise<ScheduleEntry> {
  const { schedule } = await api.schedule.add.$post({ json: { project, spec, prompt, tool } })
  return schedule
}

/** Delete a schedule by id. */
export async function removeSchedule(id: string): Promise<void> {
  await api.schedule.remove.$post({ json: { id } })
}
