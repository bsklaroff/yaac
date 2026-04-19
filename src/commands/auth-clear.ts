import readline from 'node:readline/promises'
import { listTokens, removeToken, saveCredentials } from '@/lib/project/credentials'
import {
  cleanupProjectClaudePlaceholders,
  cleanupProjectCodexPlaceholders,
  loadToolAuthEntry,
  removeToolAuth,
} from '@/lib/project/tool-auth'

export async function authClear(): Promise<void> {
  const tokens = await listTokens()
  const claude = await loadToolAuthEntry('claude')
  const codex = await loadToolAuthEntry('codex')

  if (tokens.length === 0 && !claude && !codex) {
    console.log('No credentials configured.')
    return
  }

  const entries: Array<{ label: string; action: () => Promise<void> }> = []

  for (const { pattern, tokenPreview } of tokens) {
    entries.push({
      label: `GitHub token: ${pattern} (${tokenPreview})`,
      action: async () => {
        const removed = await removeToken(pattern)
        if (removed) console.log(`Removed GitHub token for pattern "${pattern}".`)
      },
    })
  }

  if (claude) {
    const preview = claude.apiKey.length > 4 ? '***' + claude.apiKey.slice(-4) : '****'
    entries.push({
      label: `Claude Code credentials (${preview})`,
      action: async () => {
        await removeToolAuth('claude')
        await cleanupProjectClaudePlaceholders()
        console.log('Removed Claude Code credentials.')
      },
    })
  }

  if (codex) {
    const preview = codex.apiKey.length > 4 ? '***' + codex.apiKey.slice(-4) : '****'
    entries.push({
      label: `Codex credentials (${preview})`,
      action: async () => {
        await removeToolAuth('codex')
        await cleanupProjectCodexPlaceholders()
        console.log('Removed Codex credentials.')
      },
    })
  }

  console.log('Configured credentials:')
  for (let i = 0; i < entries.length; i++) {
    console.log(`  ${String(i + 1).padEnd(2)} ${entries[i].label}`)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('Remove which entry? (number, or "all"): ')).trim()
  rl.close()

  if (answer.toLowerCase() === 'all') {
    await saveCredentials({ tokens: [] })
    await removeToolAuth('claude')
    await removeToolAuth('codex')
    await cleanupProjectClaudePlaceholders()
    await cleanupProjectCodexPlaceholders()
    console.log('All credentials removed.')
    return
  }

  const idx = parseInt(answer, 10)
  if (isNaN(idx) || idx < 1 || idx > entries.length) {
    console.log('Cancelled.')
    return
  }

  await entries[idx - 1].action()
}
