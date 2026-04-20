import readline from 'node:readline/promises'
import { getClient, exitOnClientError, type DaemonClient } from '@/lib/daemon-client'
import type { AuthListResult } from '@/lib/auth/list'

export async function authClear(): Promise<void> {
  let client: DaemonClient
  let summary: AuthListResult
  try {
    client = await getClient()
    summary = await client.get<AuthListResult>('/auth/list')
  } catch (err) {
    exitOnClientError(err)
  }

  const { githubTokens, toolAuth } = summary

  if (githubTokens.length === 0 && toolAuth.length === 0) {
    console.log('No credentials configured.')
    return
  }

  interface Entry {
    label: string
    run: () => Promise<void>
  }

  const entries: Entry[] = []
  for (const { pattern, tokenPreview } of githubTokens) {
    entries.push({
      label: `GitHub token: ${pattern} (${tokenPreview})`,
      run: async () => {
        await client.delete(`/auth/github/tokens/${encodeURIComponent(pattern)}`)
        console.log(`Removed GitHub token for pattern "${pattern}".`)
      },
    })
  }
  for (const entry of toolAuth) {
    const label = entry.tool === 'claude' ? 'Claude Code' : 'Codex'
    entries.push({
      label: `${label} credentials (${entry.keyPreview})`,
      run: async () => {
        await client.post('/auth/clear', { service: entry.tool })
        console.log(`Removed ${label} credentials.`)
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

  try {
    if (answer.toLowerCase() === 'all') {
      await client.post('/auth/clear', { service: 'all' })
      // Remaining GitHub tokens get cleared by `all`, but the daemon's
      // `clearAuth('all')` already wipes them — nothing extra to do.
      console.log('All credentials removed.')
      return
    }

    const idx = parseInt(answer, 10)
    if (isNaN(idx) || idx < 1 || idx > entries.length) {
      console.log('Cancelled.')
      return
    }

    await entries[idx - 1].run()
  } catch (err) {
    exitOnClientError(err)
  }
}
