import readline from 'node:readline/promises'
import { getRpcClient } from '#commands/rpc'

export async function authClear(): Promise<void> {
  const client = await getRpcClient()
  const { gitCredentials, toolAuth } = await client.auth.list.$get().then((r) => r.json())

  if (gitCredentials.length === 0 && toolAuth.length === 0) {
    console.log('No credentials configured.')
    return
  }

  interface Entry {
    label: string
    run: () => Promise<void>
  }

  const entries: Entry[] = []
  for (const { kind, pattern, preview } of gitCredentials) {
    entries.push({
      label: `Git ${kind}: ${pattern} (${preview})`,
      run: async () => {
        // Path segment must be URL-encoded: patterns like "github.com/acme/*"
        // carry literal slashes that the Hono client would otherwise pass
        // through, breaking the :pattern route match.
        await client.auth.git.credentials[':pattern'].$delete({
          param: { pattern: encodeURIComponent(pattern) },
        })
        console.log(`Removed git credential for pattern "${pattern}".`)
      },
    })
  }
  for (const entry of toolAuth) {
    const label =
      entry.tool === 'claude' ? 'Claude Code' :
      entry.tool === 'codex' ? 'Codex' :
      'OpenCode'
    entries.push({
      label: `${label} credentials (${entry.keyPreview})`,
      run: async () => {
        await client.auth.clear.$post({ json: { service: entry.tool } })
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

  if (answer.toLowerCase() === 'all') {
    await client.auth.clear.$post({ json: { service: 'all' } })
    console.log('All credentials removed.')
    return
  }

  const idx = parseInt(answer, 10)
  if (isNaN(idx) || idx < 1 || idx > entries.length) {
    console.log('Cancelled.')
    return
  }

  await entries[idx - 1].run()
}
