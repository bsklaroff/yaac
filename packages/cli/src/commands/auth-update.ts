import readline from 'node:readline/promises'
import { getApiClient } from '@yaac/shared/server-api'
import { ensureAuthDaemon } from '@yaac/shared/auth-daemon'
import { runRelayedToolLogin } from '#commands/relayed-login'
import { validatePattern, parsePattern } from '@yaac/shared/credentials'
import {
  buildAuthPayload,
  promptForApiKey,
  runToolLogin,
} from '@yaac/shared/tool-auth-interactive'
import type { AgentTool } from '@yaac/shared/types'

export async function authUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('What would you like to authenticate?')
  console.log('  1) Git credentials (HTTPS token or SSH key)')
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
  if (answer === '5') {
    await runToolUpdate('pi')
    return
  }
  console.log('Cancelled.')
}

async function runGitUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Credential type:')
  console.log('  a) HTTPS (personal access token)')
  console.log('  b) SSH (a key yaac generates)')
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
  const client = getApiClient()
  await client.auth.git.credentials.$post({
    json: { kind: 'https', pattern, token },
  })
  console.log(`Credential saved for pattern "${pattern}".`)
}

async function runSshUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Generate an SSH key for a git host. The server keeps the private key encrypted')
  console.log('and never shows it; you register the public key with the host.')
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
  const host = parsePattern(pattern).host

  console.log(`Known-hosts entry for ${host} — press Enter to let the server fetch it via ssh, or paste the line:`)
  const knownHostsEntry = (await rl.question('Entry: ')).trim()
  rl.close()

  const client = getApiClient()
  const generated = await client.auth.git['ssh-keys'].$post({
    json: { pattern, ...(knownHostsEntry ? { knownHostsEntry } : {}) },
  })
  console.log(`SSH key generated for pattern "${pattern}". If this pattern already had a key,`)
  console.log('the previous public key no longer works.')
  console.log(`Host key: ${generated.knownHostsEntry}`)
  console.log(`Public key — add it to ${host} as a deploy key, or to your account:`)
  console.log(generated.publicKey)
}

async function runToolUpdate(tool: AgentTool): Promise<void> {
  const label =
    tool === 'claude' ? 'Claude Code' :
    tool === 'codex' ? 'Codex' :
    tool === 'pi' ? 'Pi' :
    'OpenCode'

  // Shortcut paths that capture a result directly: the e2e hook and the
  // opencode/pi api-key prompt.
  let result = await runToolLogin(tool).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })

  if (!result && (tool === 'claude' || tool === 'codex')) {
    // Browser sign-in, executed by the auth server on this machine and
    // persisted by it straight to the (possibly remote) main server.
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
      // cli-missing: the vendor CLI isn't installed here — offer the key.
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
