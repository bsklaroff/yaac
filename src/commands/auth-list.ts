import { listTokens } from '@/lib/credentials'

export async function authList(): Promise<void> {
  const tokens = await listTokens()
  if (tokens.length === 0) {
    console.log('No tokens configured. Run "yaac auth update" to add one.')
    return
  }

  console.log('#  Pattern                    Token')
  for (let i = 0; i < tokens.length; i++) {
    const { pattern, tokenPreview } = tokens[i]
    const num = String(i + 1).padEnd(2)
    const pat = pattern.padEnd(27)
    console.log(`${num} ${pat} ${tokenPreview}`)
  }
}
