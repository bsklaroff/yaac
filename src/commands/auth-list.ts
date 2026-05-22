import { getRpcClient, toClientError } from '@/commands/rpc'
import type { ToolAuthSummary } from '@/shared/types'

export async function authList(): Promise<void> {
  const client = await getRpcClient()
  const res = await client.auth.list.$get()
  if (!res.ok) throw await toClientError(res)
  const result = await res.json()

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
}

function printToolAuth(label: 'claude' | 'codex', entry: ToolAuthSummary | undefined): void {
  const padded = label.padEnd(9)
  if (!entry) {
    console.log(`  ${padded} not configured`)
    return
  }
  const kindLabel = entry.kind === 'oauth' ? 'oauth' : 'api-key'
  console.log(`  ${padded} ${entry.keyPreview}  (${kindLabel}, saved ${entry.savedAt.slice(0, 10)})`)
}
