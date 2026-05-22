import readline from 'node:readline/promises'
import * as childProcess from 'node:child_process'
import { getRpcClient, toClientError } from '@/shared/daemon-client'
import { validatePattern, parsePattern } from '@/shared/credentials'
import { torSshOpts } from '@/shared/git'
import {
  promptForApiKey,
  runToolLogin,
  type ToolLoginResult,
} from '@/shared/tool-auth-interactive'
import type { AgentTool, ClaudeOAuthBundle, CodexOAuthBundle } from '@/shared/types'

/**
 * ssh-keyscan via spawn (not execFile/promisify). spawn is the only
 * child_process export some test suites mock — avoiding execFile at
 * module load keeps those tests from blowing up on import.
 */
function runSshKeyscan(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('ssh-keyscan', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`ssh-keyscan exited with code ${code ?? '?'}: ${stderr.trim()}`))
    })
  })
}

type ToolAuthPayload =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth'; bundle: ClaudeOAuthBundle | CodexOAuthBundle }

export async function authUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('What would you like to authenticate?')
  console.log('  1) Git credentials (HTTPS token or SSH key)')
  console.log('  2) Claude Code (Anthropic)')
  console.log('  3) Codex (OpenAI)')
  console.log('  4) OpenCode (OpenRouter)')
  const answer = (await rl.question('Choice [1-4]: ')).trim()
  rl.close()

  if (answer === '1') {
    await runGitUpdate()
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
  if (answer === '4') {
    await runToolUpdate('opencode')
    return
  }
  console.log('Cancelled.')
}

async function runGitUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Credential type:')
  console.log('  a) HTTPS (personal access token)')
  console.log('  b) SSH (private key reference)')
  const kindAnswer = (await rl.question('Choice [a/b]: ')).trim().toLowerCase()
  rl.close()

  if (kindAnswer === 'a' || kindAnswer === 'https') {
    await runHttpsUpdate()
    return
  }
  if (kindAnswer === 'b' || kindAnswer === 'ssh') {
    await runSshUpdate()
    return
  }
  console.log('Cancelled.')
}

async function runHttpsUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Add an HTTPS git credential.')
  console.log('Pattern examples: github.com/*, github.com/acme/*, github.com/acme/repo, git.example.com/team/*')
  const pattern = (await rl.question('Repo pattern: ')).trim()
  if (!pattern) {
    rl.close()
    console.error('Pattern cannot be empty.')
    process.exit(1)
  }
  if (!validatePattern(pattern)) {
    rl.close()
    console.error('Invalid pattern. Use <host>/*, <host>/<owner>/*, or <host>/<owner>/<repo>.')
    process.exit(1)
  }
  const token = (await rl.question('Token (PAT): ')).trim()
  rl.close()
  if (!token) {
    console.error('Token cannot be empty.')
    process.exit(1)
  }
  const client = await getRpcClient()
  const res = await client.auth.git.credentials.$post({
    json: { kind: 'https', pattern, token },
  })
  if (!res.ok) throw await toClientError(res)
  console.log(`Credential saved for pattern "${pattern}".`)
}

async function runSshUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Add an SSH git credential.')
  console.log('Pattern examples: git.example.com/*, git.example.com/team/*, git.example.com/team/repo')
  const pattern = (await rl.question('Repo pattern: ')).trim()
  if (!pattern) {
    rl.close()
    console.error('Pattern cannot be empty.')
    process.exit(1)
  }
  if (!validatePattern(pattern)) {
    rl.close()
    console.error('Invalid pattern. Use <host>/*, <host>/<owner>/*, or <host>/<owner>/<repo>.')
    process.exit(1)
  }

  const privateKeyPath = (await rl.question('Private key path (host filesystem; e.g. ~/.ssh/id_ed25519): ')).trim()
  if (!privateKeyPath) {
    rl.close()
    console.error('Private key path cannot be empty.')
    process.exit(1)
  }

  let host: string
  try {
    host = parsePattern(pattern).host
  } catch {
    rl.close()
    console.error('Could not derive host from pattern.')
    process.exit(1)
  }

  console.log(`Known-hosts entry for ${host} — paste the line, or type "fetch" to run ssh-keyscan:`)
  let knownHostsEntry = (await rl.question('Entry: ')).trim()
  if (knownHostsEntry.toLowerCase() === 'fetch') {
    try {
      const args = ['-H', ...torSshOpts(), host]
      const stdout = await runSshKeyscan(args)
      const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      if (lines.length === 0) {
        rl.close()
        console.error(`ssh-keyscan returned no entries for ${host}.`)
        process.exit(1)
      }
      console.log('ssh-keyscan returned:')
      for (let i = 0; i < lines.length; i++) {
        console.log(`  ${i + 1}) ${lines[i]}`)
      }
      const pickAnswer = (await rl.question('Use which entry? [1]: ')).trim() || '1'
      const pick = parseInt(pickAnswer, 10)
      if (isNaN(pick) || pick < 1 || pick > lines.length) {
        rl.close()
        console.error('Cancelled.')
        process.exit(1)
      }
      knownHostsEntry = lines[pick - 1]
    } catch (err) {
      rl.close()
      console.error(`ssh-keyscan failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }
  rl.close()

  if (!knownHostsEntry) {
    console.error('Known-hosts entry cannot be empty.')
    process.exit(1)
  }

  const client = await getRpcClient()
  const res = await client.auth.git.credentials.$post({
    json: { kind: 'ssh', pattern, privateKeyPath, knownHostsEntry },
  })
  if (!res.ok) throw await toClientError(res)
  console.log(`SSH credential saved for pattern "${pattern}".`)
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
  const client = await getRpcClient()
  const res = await client.auth[':tool'].$put({ param: { tool }, json: payload })
  if (!res.ok) throw await toClientError(res)
  const label =
    tool === 'claude' ? 'Claude Code' :
    tool === 'codex' ? 'Codex' :
    'OpenCode'
  console.log(`${label} credentials saved.`)
}

function buildAuthPayload(tool: AgentTool, result: ToolLoginResult): ToolAuthPayload {
  if (tool === 'claude' && result.kind === 'oauth' && result.claudeBundle) {
    return { kind: 'oauth', bundle: result.claudeBundle }
  }
  if (tool === 'codex' && result.kind === 'oauth' && result.codexBundle) {
    return { kind: 'oauth', bundle: result.codexBundle }
  }
  if (!result.apiKey) {
    throw new Error('No credentials captured from tool login.')
  }
  return { kind: 'api-key', apiKey: result.apiKey }
}
