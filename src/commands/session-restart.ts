import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import simpleGit from 'simple-git'
import { getRpcClient, toClientError } from '@/commands/rpc'
import { getGitUserConfig } from '@/shared/git'

export interface SessionRestartOptions {
  addDir?: string[]
  addDirRw?: string[]
}

interface SessionRestartResult {
  sessionId?: string
  containerName?: string
}

type StreamEvent =
  | { type: 'progress'; message: string }
  | { type: 'result'; result: SessionRestartResult }
  | { type: 'error'; error: { code: string; message: string } }

async function consumeStream(res: Response): Promise<SessionRestartResult> {
  if (!res.body) throw new Error('daemon returned an empty response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result: SessionRestartResult | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += decoder.decode(value, { stream: true })
    if (done) {
      buf += decoder.decode()
      break
    }
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const event = JSON.parse(line) as StreamEvent
      if (event.type === 'progress') console.log(event.message)
      else if (event.type === 'result') result = event.result
      else if (event.type === 'error') throw new Error(event.error.message)
    }
  }
  if (buf) {
    const event = JSON.parse(buf) as StreamEvent
    if (event.type === 'progress') console.log(event.message)
    else if (event.type === 'result') result = event.result
    else if (event.type === 'error') throw new Error(event.error.message)
  }
  if (!result) throw new Error('daemon stream ended without a result event')
  return result
}

/**
 * CLI entry for `yaac session restart <sessionId>`. Resolves git identity
 * up-front (prompting when missing), then hands the restart off to the
 * daemon. The daemon tears down the old container, keeps the worktree,
 * and spins up a fresh container running the agent with `--resume`.
 */
export async function sessionRestart(
  sessionId: string,
  options: SessionRestartOptions,
): Promise<string | undefined> {
  for (const dirPath of [...(options.addDir ?? []), ...(options.addDirRw ?? [])]) {
    if (!path.isAbsolute(dirPath)) {
      console.error(`--add-dir path must be absolute: "${dirPath}"`)
      process.exitCode = 1
      return
    }
    try {
      await fs.access(dirPath)
    } catch {
      console.error(`--add-dir path not found: "${dirPath}"`)
      process.exitCode = 1
      return
    }
  }

  let gitUser = await getGitUserConfig()
  if (gitUser) {
    console.log(`Git identity: ${gitUser.name} <${gitUser.email}>`)
  } else {
    console.log('No global git user configured. Git commits require a user identity.')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const name = await rl.question('Enter git user.name: ')
    const email = await rl.question('Enter git user.email: ')
    rl.close()
    if (!name || !email) {
      console.error('Git user.name and user.email are required.')
      process.exitCode = 1
      return
    }
    await simpleGit().addConfig('user.name', name, false, 'global')
    await simpleGit().addConfig('user.email', email, false, 'global')
    gitUser = { name, email }
  }

  const client = await getRpcClient()
  const res = await client.session.restart.$post({
    json: {
      sessionId,
      addDir: options.addDir,
      addDirRw: options.addDirRw,
      gitUser,
    },
  })
  if (!res.ok) throw await toClientError(res)

  const result = await consumeStream(res)

  const { sessionId: restartedId, containerName } = result
  if (!restartedId || !containerName) {
    console.error('Daemon did not return a sessionId/containerName.')
    process.exitCode = 1
    return
  }

  if (process.env.YAAC_E2E_NO_ATTACH !== '1') {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('podman', ['exec', '-it', containerName, 'tmux', 'attach-session', '-t', 'yaac'], {
          stdio: 'inherit',
        })
        child.on('close', () => resolve())
        child.on('error', reject)
      })
    } catch {
      // Container or tmux session was killed — reaper will clean up.
    }
  }

  return restartedId
}
