import { api } from '#commands/api'
import type { AgentTool } from '@yaac/shared/types'

export interface ScheduleAddOptions {
  /** Required by commander (requiredOption) before the action runs. */
  cron: string
  prompt: string
  tool?: AgentTool
}

/**
 * CLI entry point for `yaac schedule add`: register a cron schedule that
 * starts a headless session in the project with the given prompt.
 */
export async function scheduleAdd(projectSlug: string, options: ScheduleAddOptions): Promise<void> {
  const { schedule } = await api.schedule.add.$post({
    json: {
      project: projectSlug,
      spec: options.cron,
      prompt: options.prompt,
      tool: options.tool,
    },
  })
  console.log(`Schedule ${schedule.id} added: "${schedule.spec}" in ${schedule.projectSlug}.`)
}
