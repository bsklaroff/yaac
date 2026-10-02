import readline from 'node:readline/promises'
import { getApiClient } from '@yaac/shared/server-api'
import { ensureAuthDaemon } from '@yaac/shared/auth-daemon'
import { runRelayedToolLogin } from '#commands/relayed-login'
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
    // Browser sign-in runs in the auth daemon on this machine, which saves
    // the result straight to the (possibly remote) server.
    try {
      await ensureAuthDaemon()
      const outcome = await runRelayedToolLogin(tool)
      if (outcome === 'success') {
        console.log(`${label} credentials saved.`)
        return
      }
      if (outcome === 'error') {
        process.exit(1)
      }
      // 'cli-missing': fall back to an API key.
      console.log(`The ${label} CLI is not installed on this machine — enter an API key instead.`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      console.log('Falling back to API-key entry.')
    }
    result = await promptForApiKey(tool)
  }
  if (!result) {
    result = await promptForApiKey(tool)
  }

  const payload = buildAuthPayload(tool, result)
  const client = getApiClient()
  await client.auth[':tool'].$put({ param: { tool }, json: payload })
  console.log(`${label} credentials saved.`)
}
