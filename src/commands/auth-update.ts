import readline from 'node:readline/promises'
import { getClient, exitOnClientError } from '@/lib/daemon-client'
import {
  promptForApiKey,
  runToolLogin,
  type ToolLoginResult,
} from '@/lib/project/tool-auth'
import { validatePattern } from '@/lib/project/credentials'
import type { AgentTool } from '@/types'

export async function authUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('What would you like to authenticate?')
  console.log('  1) GitHub repository token')
  console.log('  2) Claude Code (Anthropic)')
  console.log('  3) Codex (OpenAI)')
  const answer = (await rl.question('Choice [1-3]: ')).trim()
  rl.close()

  if (answer === '1') {
    await runGithubUpdate()
    return
  }
  if (answer === '2') {
    await runToolUpdate('claude')
    return
  }
  if (answer === '3') {
    await runToolUpdate('codex')
    return
  }
  console.log('Cancelled.')
}

async function runGithubUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Add a GitHub Personal Access Token.')
  console.log('Pattern examples: * (default), owner/*, owner/repo')
  const pattern = (await rl.question('Repo pattern: ')).trim()
  if (!pattern) {
    rl.close()
    console.error('Pattern cannot be empty.')
    process.exit(1)
  }
  if (!validatePattern(pattern)) {
    rl.close()
    console.error('Invalid pattern. Use *, owner/*, or owner/repo.')
    process.exit(1)
  }
  const token = (await rl.question('GitHub PAT: ')).trim()
  rl.close()
  if (!token) {
    console.error('Token cannot be empty.')
    process.exit(1)
  }
  try {
    const client = await getClient()
    await client.post('/auth/github/tokens', { pattern, token })
  } catch (err) {
    exitOnClientError(err)
  }
  console.log(`Token saved for pattern "${pattern}".`)
}

async function runToolUpdate(tool: AgentTool): Promise<void> {
  // Interactive tool-login must happen CLI-side — the daemon can't run
  // `claude login` / `codex login` and drive their OAuth flows. We
  // capture the resulting bundle and hand it to the daemon to persist.
  let result: ToolLoginResult
  try {
    result = await runToolLogin(tool)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  if (!result.apiKey && !result.claudeBundle && !result.codexBundle) {
    result = await promptForApiKey(tool)
  }

  const payload = buildAuthPayload(tool, result)
  try {
    const client = await getClient()
    await client.put(`/auth/${tool}`, payload)
  } catch (err) {
    exitOnClientError(err)
  }
  const label = tool === 'claude' ? 'Claude Code' : 'Codex'
  console.log(`${label} credentials saved.`)
}

function buildAuthPayload(tool: AgentTool, result: ToolLoginResult): Record<string, unknown> {
  if (tool === 'claude' && result.kind === 'oauth' && result.claudeBundle) {
    return { kind: 'oauth', bundle: result.claudeBundle }
  }
  if (tool === 'codex' && result.kind === 'oauth' && result.codexBundle) {
    return { kind: 'oauth', bundle: result.codexBundle }
  }
  return { kind: 'api-key', apiKey: result.apiKey }
}
