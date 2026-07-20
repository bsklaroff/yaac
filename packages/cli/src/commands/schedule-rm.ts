import { api } from '#commands/api'

/**
 * CLI entry point for `yaac schedule rm`. Accepts a full schedule id or the
 * unique 8-char prefix `schedule list` displays.
 */
export async function scheduleRm(id: string): Promise<void> {
  let target = id
  // Resolve a prefix against the full list so users can paste the short id.
  const { schedules } = await api.schedule.list.$get({ query: {} })
  const matches = schedules.filter((s) => s.id.startsWith(id))
  if (matches.length > 1) {
    console.error(`Schedule id "${id}" is ambiguous (${matches.length} matches).`)
    process.exitCode = 1
    return
  }
  if (matches.length === 1) target = matches[0].id

  await api.schedule.remove.$post({ json: { id: target } })
  console.log(`Schedule ${target} removed.`)
}
