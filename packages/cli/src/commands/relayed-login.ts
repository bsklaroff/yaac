import readline from 'node:readline/promises'
import { api } from '#commands/api'
import type { ToolLoginView } from '@yaac/shared/types'

/**
 * Drive a relayed browser sign-in from the terminal. The auth daemon on this
 * machine runs the vendor CLI's login (opening the browser and capturing the
 * credentials); this starts it through the server's routes, prints the CLI's
 * output (including the sign-in URL if no browser opened), forwards a pasted
 * authorize code, and polls until it finishes. The web app's sign-in card
 * uses the same routes.
 */

const POLL_MS = 700

export type RelayedLoginOutcome = 'success' | 'cli-missing' | 'error'

export async function runRelayedToolLogin(tool: 'claude' | 'codex'): Promise<RelayedLoginOutcome> {
  let view = await api.auth[':tool'].login.start.$post({ param: { tool } }) as ToolLoginView
  const id = view.id

  console.log('Complete the sign-in in your browser — vendor CLI output follows.')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let pasted: string | null = null
  void rl.question('Paste the authorize code here if the page shows one (Enter to skip): ')
    .then((answer) => { pasted = answer.trim() })
    .catch(() => { /* rl closed when the flow ended */ })

  // Print only new lines. The output usually grows by appending; if the
  // server's dedupe shrinks it, resync without reprinting.
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
          try {
            await api.auth.login[':id'].input.$post({ param: { id }, json: { text } })
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err))
          }
        }
      }
      view = await api.auth.login[':id'].$get({ param: { id } }) as ToolLoginView
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
