import { api } from '#commands/api'
import { truncatePrompt } from '#commands/worktree-list'

/**
 * `yaac worktree agents <id>` — the conversations a worktree holds.
 *
 * Active ones first: those are what a restart brings back, and the rest are
 * the worktree's history (a conversation left behind by `/clear`, or one
 * whose window was closed). The id column is the tool's own conversation id —
 * the id the agent itself knows it by, useful for resuming one by hand
 * inside the worktree.
 */
export async function worktreeAgents(idOrName: string): Promise<void> {
  const agents = await api.worktree[':id']['agent-sessions'].$get({
    param: { id: idOrName },
  })

  if (agents.length === 0) {
    console.log(`No agent sessions recorded for worktree "${idOrName}".`)
    return
  }

  const sorted = [...agents].sort((a, b) =>
    Number(b.active) - Number(a.active) || a.ordinal - b.ordinal)

  const idWidth = Math.max('AGENT SESSION'.length, ...sorted.map((a) => a.agentSessionId.length))
  const toolWidth = Math.max('TOOL'.length, ...sorted.map((a) => a.tool.length))
  const fixedWidth = idWidth + 1 + toolWidth + 1 + 8 + 2
  const promptWidth = Math.max(10, (process.stdout.columns || 120) - fixedWidth)

  console.log('')
  console.log(`${'AGENT SESSION'.padEnd(idWidth)} ${'TOOL'.padEnd(toolWidth)} ${'STATE'.padEnd(8)}  FIRST MESSAGE`)
  console.log(`${'-'.repeat(idWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(8)}  ${'-'.repeat(Math.min(promptWidth, 40))}`)
  for (const a of sorted) {
    const state = a.active ? 'open' : 'closed'
    console.log(`${a.agentSessionId.padEnd(idWidth)} ${a.tool.padEnd(toolWidth)} ${state.padEnd(8)}  ${truncatePrompt(a.prompt, promptWidth)}`)
  }
  console.log('')
}
