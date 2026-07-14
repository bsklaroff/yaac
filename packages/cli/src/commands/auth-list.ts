import { api } from '#commands/api'
import type { ToolAuthSummary } from '@yaac/shared/types'

export async function authList(): Promise<void> {
  const result = await api.auth.list.$get()

  console.log('Git credentials:')
  if (result.gitCredentials.length === 0) {
    console.log('  (none configured)')
  } else {
    for (let i = 0; i < result.gitCredentials.length; i++) {
      const { kind, pattern, preview } = result.gitCredentials[i]
      const num = String(i + 1).padEnd(2)
      const kindCol = kind.padEnd(5)
      const pat = pattern.padEnd(35)
      console.log(`  ${num} ${kindCol} ${pat} ${preview}`)
    }
  }

  console.log('')
  console.log('Tool credentials:')
  printToolAuth('claude', result.toolAuth.find((t) => t.tool === 'claude'))
  printToolAuth('codex', result.toolAuth.find((t) => t.tool === 'codex'))
  printToolAuth('opencode', result.toolAuth.find((t) => t.tool === 'opencode'))
}

function printToolAuth(label: 'claude' | 'codex' | 'opencode', entry: ToolAuthSummary | undefined): void {
  const padded = label.padEnd(9)
  if (!entry) {
    console.log(`  ${padded} not configured`)
    return
  }
  const kindLabel = entry.kind === 'oauth' ? 'oauth' : 'api-key'
  const providerLabel = entry.opencodeProvider ? `${entry.opencodeProvider}, ` : ''
  console.log(`  ${padded} ${entry.keyPreview}  (${providerLabel}${kindLabel}, saved ${entry.savedAt.slice(0, 10)})`)
}
