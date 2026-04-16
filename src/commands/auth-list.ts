import { listTokens } from '@/lib/project/credentials'
import { loadToolAuthEntry } from '@/lib/project/tool-auth'

export async function authList(): Promise<void> {
  const tokens = await listTokens()

  console.log('GitHub tokens:')
  if (tokens.length === 0) {
    console.log('  (none configured)')
  } else {
    for (let i = 0; i < tokens.length; i++) {
      const { pattern, tokenPreview } = tokens[i]
      const num = String(i + 1).padEnd(2)
      const pat = pattern.padEnd(27)
      console.log(`  ${num} ${pat} ${tokenPreview}`)
    }
  }

  console.log('')
  console.log('Tool credentials:')

  const claude = await loadToolAuthEntry('claude')
  if (claude) {
    const preview = claude.apiKey.length > 4
      ? '***' + claude.apiKey.slice(-4)
      : '****'
    const kindLabel = claude.kind === 'oauth' ? 'oauth' : 'api-key'
    console.log(`  claude    ${preview}  (${kindLabel}, saved ${claude.savedAt.slice(0, 10)})`)
  } else {
    console.log('  claude    not configured')
  }

  const codex = await loadToolAuthEntry('codex')
  if (codex) {
    const preview = codex.apiKey.length > 4
      ? '***' + codex.apiKey.slice(-4)
      : '****'
    const kindLabel = codex.kind === 'oauth' ? 'oauth' : 'api-key'
    console.log(`  codex     ${preview}  (${kindLabel}, saved ${codex.savedAt.slice(0, 10)})`)
  } else {
    console.log('  codex     not configured')
  }
}
