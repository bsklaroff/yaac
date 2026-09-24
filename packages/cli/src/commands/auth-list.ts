import { api } from '#commands/api'
import { AGENT_TOOLS, type AgentTool, type ToolAuthSummary } from '@yaac/shared/types'

export async function authList(): Promise<void> {
  const result = await api.auth.list.$get()

  // By name: the name is what `yaac project add <url> <credential>` takes.
  console.log('Git credentials:')
  if (result.gitCredentials.length === 0) {
    console.log('  (none configured — add one in the web app\'s Settings)')
  } else {
    const width = Math.max(...result.gitCredentials.map((c) => c.name.length))
    for (const { name, kind, preview, projects } of result.gitCredentials) {
      const used = projects.length > 0 ? `  (${projects.join(', ')})` : ''
      console.log(`  ${name.padEnd(width)}  ${kind.padEnd(5)}  ${preview}${used}`)
    }
  }

  console.log('')
  console.log('Tool credentials:')
  for (const tool of AGENT_TOOLS) {
    printToolAuth(tool, result.toolAuth.find((t) => t.tool === tool))
  }
}

function printToolAuth(label: AgentTool, entry: ToolAuthSummary | undefined): void {
  const padded = label.padEnd(9)
  if (!entry) {
    console.log(`  ${padded} not configured`)
    return
  }
  const kindLabel = entry.kind === 'oauth' ? 'oauth' : 'api-key'
  const provider = entry.opencodeProvider ?? entry.piProvider
  const providerLabel = provider ? `${provider}, ` : ''
  console.log(`  ${padded} ${entry.keyPreview}  (${providerLabel}${kindLabel}, saved ${entry.savedAt.slice(0, 10)})`)
}
