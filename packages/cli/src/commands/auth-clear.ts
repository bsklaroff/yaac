import readline from 'node:readline/promises'
import { api } from '#commands/api'

export async function authClear(): Promise<void> {
  const { toolAuth } = await api.auth.list.$get()

  if (toolAuth.length === 0) {
    console.log('No credentials configured.')
    return
  }

  interface Entry {
    label: string
    run: () => Promise<void>
  }

  const entries: Entry[] = []
  for (const entry of toolAuth) {
    const label =
      entry.tool === 'claude' ? 'Claude Code' :
      entry.tool === 'codex' ? 'Codex' :
      'OpenCode'
    entries.push({
      label: `${label} credentials (${entry.keyPreview})`,
      run: async () => {
        await api.auth.clear.$post({ json: { service: entry.tool } })
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
    await api.auth.clear.$post({ json: { service: 'all' } })
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
