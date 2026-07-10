import readline from 'node:readline/promises'
import { getRpcClient, toClientError } from '#commands/rpc'
import type { ToolLoginView } from '@yaac/shared/types'

/**
 * Drive a relayed browser sign-in from the terminal. The flow itself is
 * executed by the auth server on this machine (which opens the browser
 * and captures the credentials); this driver starts it via the main
 * server's routes, streams the vendor CLI's output (the sign-in URL when
 * no browser window opened), forwards a pasted authorize code, and waits
 * for the terminal state — the same relay the webapp's sign-in card
 * drives, with readline in place of the card.
 */

const POLL_MS = 700

export type RelayedLoginOutcome = 'success' | 'cli-missing' | 'error'

export async function runRelayedToolLogin(tool: 'claude' | 'codex'): Promise<RelayedLoginOutcome> {
  const client = await getRpcClient()
  const start = await client.auth[':tool'].login.start.$post({ param: { tool } })
  if (!start.ok) throw await toClientError(start)
  let view = await start.json() as ToolLoginView
  const id = view.id

  console.log('Complete the sign-in in your browser — vendor CLI output follows.')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let pasted: string | null = null
  void rl.question('Paste the authorize code here if the page shows one (Enter to skip): ')
    .then((answer) => { pasted = answer.trim() })
    .catch(() => { /* closed while waiting — flow ended */ })

  // Print output line-by-line as it accretes. presentableOutput mostly
  // appends; if a dedupe pass shrinks it, resync silently.
  let seenLines = 0
  const printNew = (output?: string): void => {
    if (!output) return
    const lines = output.split('\n')
    if (lines.length < seenLines) seenLines = lines.length
    for (; seenLines < lines.length; seenLines++) console.log(`  ${lines[seenLines]}`)
  }
  printNew(view.output)

  try {
    while (view.status === 'running') {
      await new Promise((r) => setTimeout(r, POLL_MS))
      if (pasted !== null) {
        const text = pasted
        pasted = null
        if (text) {
          const input = await client.auth.login[':id'].input.$post({ param: { id }, json: { text } })
          if (!input.ok) console.error((await toClientError(input)).message)
        }
      }
      const res = await client.auth.login[':id'].$get({ param: { id } })
      if (!res.ok) throw await toClientError(res)
      view = await res.json() as ToolLoginView
      printNew(view.output)
    }
  } finally {
    rl.close()
  }

  if (view.status === 'success') return 'success'
  if (view.cliMissing) return 'cli-missing'
  console.error(view.error ?? 'Sign-in failed.')
  return 'error'
}
