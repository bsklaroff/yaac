import { api } from '#commands/api'
import type { ScheduleEntry } from '@yaac/shared/types'

/** CLI entry point for `yaac schedule list`. */
export async function scheduleList(projectSlug?: string): Promise<void> {
  const { schedules } = await api.schedule.list.$get({
    query: projectSlug ? { project: projectSlug } : {},
  })

  if (schedules.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No schedules${suffix}. Add one with: yaac schedule add <project> --cron "<spec>" --prompt "<text>"`)
    return
  }
  render(schedules)
}

function render(schedules: ScheduleEntry[]): void {
  const rows = schedules.map((s) => ({
    id: s.id.slice(0, 8),
    project: s.projectSlug,
    spec: s.spec,
    tool: s.tool ?? 'default',
    lastFired: s.lastFiredAt ?? 'never',
    prompt: s.prompt.replaceAll('\n', ' '),
  }))

  const projectWidth = Math.max('PROJECT'.length, ...rows.map((r) => r.project.length))
  const specWidth = Math.max('CRON'.length, ...rows.map((r) => r.spec.length))
  const toolWidth = Math.max('TOOL'.length, ...rows.map((r) => r.tool.length))
  const firedWidth = Math.max('LAST FIRED'.length, ...rows.map((r) => r.lastFired.length))

  const fixedWidth = 8 + 1 + projectWidth + 1 + specWidth + 1 + toolWidth + 1 + firedWidth + 2
  const termWidth = process.stdout.columns || 120
  const promptWidth = Math.max(10, termWidth - fixedWidth)

  console.log('')
  console.log(`${'SCHEDULE'.padEnd(8)} ${'PROJECT'.padEnd(projectWidth)} ${'CRON'.padEnd(specWidth)} ${'TOOL'.padEnd(toolWidth)} ${'LAST FIRED'.padEnd(firedWidth)}  PROMPT`)
  console.log(`${'-'.repeat(8)} ${'-'.repeat(projectWidth)} ${'-'.repeat(specWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(firedWidth)}  ${'-'.repeat(Math.min(promptWidth, 40))}`)
  for (const row of rows) {
    const prompt = row.prompt.length > promptWidth ? `${row.prompt.slice(0, promptWidth - 1)}…` : row.prompt
    console.log(`${row.id.padEnd(8)} ${row.project.padEnd(projectWidth)} ${row.spec.padEnd(specWidth)} ${row.tool.padEnd(toolWidth)} ${row.lastFired.padEnd(firedWidth)}  ${prompt}`)
  }
  console.log('')
}
