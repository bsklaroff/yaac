import readline from 'node:readline/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
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
 * Fetch a known_hosts entry for `host` by driving `ssh` (not `ssh-keyscan`).
 *
 * Why ssh: ssh-keyscan does not accept `-o ProxyCommand=…` (its `-O` flag
 * only takes `hashalg`), so it can't be routed through Tor. ssh does honor
 * `-o ProxyCommand=…`, and with StrictHostKeyChecking=accept-new +
 * UserKnownHostsFile=<tmp> it persists the negotiated host key to the temp
 * file during KEX, before BatchMode kills the auth step.
 *
 * Returns the single key type ssh actually negotiated — which is the entry
 * the subsequent git-over-ssh connection will use, so it's what we want.
 */
async function fetchKnownHostsEntry(host: string): Promise<string> {
  const tmp = path.join(
    os.tmpdir(),
    `yaac-knownhosts-${crypto.randomBytes(6).toString('hex')}`,
  )
  await fs.writeFile(tmp, '', { mode: 0o600 })
  try {
    const args = [
      '-F', '/dev/null',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${tmp}`,
      '-o', 'HashKnownHosts=no',
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=10',
      ...torSshOpts(),
      `nobody@${host}`,
      'true',
    ]
    let stderr = ''
    await new Promise<void>((resolve) => {
      const child = childProcess.spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
    })
    const written = await fs.readFile(tmp, 'utf8')
    const lines = written.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    if (lines.length === 0) {
      const tail = stderr.trim().split('\n').slice(-3).join(' | ')
      throw new Error(`no host key recovered for ${host}${tail ? `: ${tail}` : ''}`)
    }
    return lines[0]
  } finally {
    await fs.rm(tmp, { force: true })
  }
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
  console.log('Pattern examples: github.com/*, github.com/acme/*, github.com/acme/repo, gitlab.com/group/sub/*')
  const pattern = (await rl.question('Repo pattern: ')).trim()
  if (!pattern) {
    rl.close()
    console.error('Pattern cannot be empty.')
    process.exit(1)
  }
  if (!validatePattern(pattern)) {
    rl.close()
    console.error('Invalid pattern. Use <host>/*, <host>/<path>, or <host>/<prefix>/*.')
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
    console.error('Invalid pattern. Use <host>/*, <host>/<path>, or <host>/<prefix>/*.')
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

  console.log(`Known-hosts entry for ${host} — paste the line, or type "fetch" to retrieve it via ssh:`)
  let knownHostsEntry = (await rl.question('Entry: ')).trim()
  if (knownHostsEntry.toLowerCase() === 'fetch') {
    try {
      knownHostsEntry = await fetchKnownHostsEntry(host)
      console.log(`Fetched: ${knownHostsEntry}`)
    } catch (err) {
      rl.close()
      console.error(`Failed to fetch known_hosts entry: ${err instanceof Error ? err.message : String(err)}`)
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
