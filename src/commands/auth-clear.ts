import readline from 'node:readline/promises'
import { listTokens, removeToken, saveCredentials } from '@/lib/credentials'

export async function authClear(): Promise<void> {
  const tokens = await listTokens()
  if (tokens.length === 0) {
    console.log('No tokens configured.')
    return
  }

  console.log('Configured tokens:')
  for (let i = 0; i < tokens.length; i++) {
    const { pattern, tokenPreview } = tokens[i]
    const num = String(i + 1).padEnd(2)
    const pat = pattern.padEnd(27)
    console.log(`  ${num} ${pat} ${tokenPreview}`)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('Remove which entry? (number, or "all"): ')).trim()
  rl.close()

  if (answer.toLowerCase() === 'all') {
    await saveCredentials({ tokens: [] })
    console.log('All tokens removed.')
    return
  }

  const idx = parseInt(answer, 10)
  if (isNaN(idx) || idx < 1 || idx > tokens.length) {
    console.log('Cancelled.')
    return
  }

  const pattern = tokens[idx - 1].pattern
  const removed = await removeToken(pattern)
  if (removed) {
    console.log(`Removed token for pattern "${pattern}".`)
  }
}
