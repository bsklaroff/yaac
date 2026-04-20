import { getClient, exitOnClientError } from '@/lib/daemon-client'
import type { AuthListResult, ToolAuthSummary } from '@/lib/auth/list'

export async function authList(): Promise<void> {
  let result: AuthListResult
  try {
    const client = await getClient()
    result = await client.get<AuthListResult>('/auth/list')
  } catch (err) {
    exitOnClientError(err)
  }

  console.log('GitHub tokens:')
  if (result.githubTokens.length === 0) {
    console.log('  (none configured)')
  } else {
    for (let i = 0; i < result.githubTokens.length; i++) {
      const { pattern, tokenPreview } = result.githubTokens[i]
      const num = String(i + 1).padEnd(2)
      const pat = pattern.padEnd(27)
      console.log(`  ${num} ${pat} ${tokenPreview}`)
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
