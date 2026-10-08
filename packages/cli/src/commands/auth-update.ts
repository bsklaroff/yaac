import readline from 'node:readline/promises'
import { getApiClient } from '@yaac/shared/server-api'
import { seedGitIdentityFromShell } from '@yaac/shared/git-identity-seed'
import {
  getToolLogin,
  killAllToolLogins,
  sendToolLoginInput,
  setToolLoginPersistence,
  startToolLogin,
} from '@yaac/auth-daemon/tool-login'
import {
  buildAuthPayload,
  promptForApiKey,
  runToolLogin,
} from '@yaac/shared/tool-auth-interactive'
import { TOOL_LABELS, type AgentTool } from '@yaac/shared/types'

export async function authUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('What would you like to authenticate?')
  console.log('  1) Git credential (HTTPS token or SSH key)')
  console.log('  2) Claude Code (Anthropic)')
  console.log('  3) Codex (OpenAI)')
  console.log('  4) OpenCode (any supported provider)')
  console.log('  5) Pi (any supported provider)')
  const answer = (await rl.question('Choice [1-5]: ')).trim()
  rl.close()

  if (answer === '1') {
    await runGitUpdate()
    return
  }
  const choices: Partial<Record<string, AgentTool>> = { 2: 'claude', 3: 'codex', 4: 'opencode', 5: 'pi' }
  const tool = choices[answer]
  if (tool === undefined) {
    console.log('Cancelled.')
    return
  }
  await runToolUpdate(tool)
}

/**
 * Add a named git credential: a pasted HTTPS token, or an SSH key the server
 * generates (docs/git-credentials.md). The name is what `yaac project add`
 * takes; Enter accepts a default no other credential has.
 */
async function runGitUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Credential type:')
  console.log('  a) HTTPS (personal access token)')
  console.log('  b) SSH (a key yaac generates)')
  const kindAnswer = (await rl.question('Choice [a/b]: ')).trim().toLowerCase()
  const kind = kindAnswer === 'a' || kindAnswer === 'https' ? 'https'
    : kindAnswer === 'b' || kindAnswer === 'ssh' ? 'ssh'
    : null
  if (kind === null) {
    rl.close()
    console.log('Cancelled.')
    return
  }

  const client = getApiClient()
  const taken = (await client.auth.list.$get()).gitCredentials.map((c) => c.name)
  const base = kind === 'https' ? 'git-token' : 'git-key'
  let fallback = base
  for (let n = 2; taken.includes(fallback); n++) fallback = `${base}-${n}`
  const name = (await rl.question(`Name [${fallback}]: `)).trim() || fallback

  if (kind === 'https') {
    const token = (await rl.question('Token (PAT): ')).trim()
    rl.close()
    if (!token) throw new Error('Token cannot be empty.')
    await client.auth.git.credentials.$post({ json: { name, token } })
    console.log(`Git credential "${name}" saved.`)
  } else {
    rl.close()
    const { publicKey } = await client.auth.git['ssh-keys'].$post({ json: { name } })
    console.log(`SSH key "${name}" generated. The server keeps the private key encrypted and never`)
    console.log('shows it. Register this public key with your git host, as a deploy key or on your account:')
    console.log(publicKey)
  }
  console.log(`Add a project with it: yaac project add <remote-url> '${name}'`)
}

async function runToolUpdate(tool: AgentTool): Promise<void> {
  const label = TOOL_LABELS[tool]

  // Returns a result directly for the e2e hook and the opencode/pi api-key
  // prompt; otherwise null.
  let result = await runToolLogin(tool)

  if (!result && (tool === 'claude' || tool === 'codex')) {
    const outcome = await runBrowserLogin(tool)
    if (outcome === 'success') {
      console.log(`${label} credentials saved.`)
      return
    }
    if (outcome === 'error') process.exit(1)
    console.log(`The ${label} CLI is not installed on this machine — enter an API key instead.`)
  }
  result ??= await promptForApiKey(tool)

  const payload = buildAuthPayload(tool, result)
  const client = getApiClient()
  await client.auth[':tool'].$put({ param: { tool }, json: payload })
  console.log(`${label} credentials saved.`)
}

const POLL_MS = 500

/**
 * Run the vendor CLI's browser sign-in in this process, where the browser
 * and its localhost OAuth callback are, and save the result to the (possibly
 * remote) server. Prints the CLI's output, which carries the sign-in URL when
 * no browser opened, and forwards a pasted authorize code. A machine with no
 * git identity on the server gets one from the local git config first.
 */
async function runBrowserLogin(tool: 'claude' | 'codex'): Promise<'success' | 'cli-missing' | 'error'> {
  const client = getApiClient()
  setToolLoginPersistence(async (t, result) => {
    await client.auth[':tool'].$put({ param: { tool: t }, json: buildAuthPayload(t, result) })
  })
  try {
    await seedGitIdentityFromShell()
  } catch (err) {
    console.error(`Could not set the git identity: ${err instanceof Error ? err.message : String(err)}`)
  }

  // However this process ends, the vendor CLI and its scratch config home,
  // which holds a live refresh token, go with it.
  process.once('exit', killAllToolLogins)
  const abort = (): never => process.exit(130)
  process.once('SIGTERM', abort)
  process.once('SIGHUP', abort)

  let view = await startToolLogin(tool)
  if (view.status === 'error' && view.cliMissing) return 'cli-missing'
  console.log('Complete the sign-in in your browser — vendor CLI output follows.')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.on('SIGINT', abort)
  let pasted: string | null = null
  void rl.question('Paste the authorize code here if the page shows one (Enter to skip): ')
    .then((answer) => { pasted = answer.trim() })
    .catch(() => { /* rl closed when the flow ended */ })

  // Print only new lines. The output usually grows by appending; if the
  // dedupe in presentableOutput shrinks it, resync without reprinting.
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
      if (pasted) {
        try {
          sendToolLoginInput(view.id, pasted)
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err))
        }
      }
      pasted = null
      view = getToolLogin(view.id)
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
