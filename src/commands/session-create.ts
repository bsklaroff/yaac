import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import simpleGit from 'simple-git'
import { getRpcClient, toClientError } from '@/commands/rpc'
import { getGitUserConfig } from '@/shared/git'
import { getProjectsDir } from '@/shared/paths'
import type { AgentTool } from '@/shared/types'

export interface SessionCreateOptions {
  addDir?: string[]
  addDirRw?: string[]
  tool?: AgentTool
}

interface SessionCreateResult {
  sessionId?: string
  containerName?: string
}

type StreamEvent =
  | { type: 'progress'; message: string }
  | { type: 'result'; result: SessionCreateResult }
  | { type: 'error'; error: { code: string; message: string } }

/**
 * Read the NDJSON event stream returned by `POST /session/create`,
 * printing progress lines and returning the terminal `result` event.
 * Throws with the daemon's message if the stream carries an `error`
 * event or ends without a result.
 */
async function consumeSessionCreateStream(res: Response): Promise<SessionCreateResult> {
  if (!res.body) throw new Error('daemon returned an empty response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result: SessionCreateResult | null = null
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
 * CLI entry point for `yaac session create`. Prompts for git identity
 * when the global config is missing, then hands provisioning off to
 * the daemon via `POST /session/create`. The daemon owns the worktree,
 * container, and port forwarders for the session's lifetime; the CLI
 * just attaches the user's terminal to the resulting tmux session.
 */
export async function sessionCreate(projectSlug: string, options: SessionCreateOptions): Promise<string | undefined> {
  // Local fast-fail on an unknown project slug so the user gets an
  // immediate error instead of a round-trip to the daemon (and so tests
  // can exercise this path without a running daemon). The daemon re-
  // validates.
  try {
    await fs.access(path.join(getProjectsDir(), projectSlug))
  } catch {
    console.error(`Project "${projectSlug}" not found. Run "yaac project list" to see available projects.`)
    process.exitCode = 1
    return
  }

  // Local fast-fail on --add-dir paths so the user gets an immediate error
  // instead of a round-trip to the daemon. The daemon re-validates.
  for (const dirPath of [...(options.addDir ?? []), ...(options.addDirRw ?? [])]) {
    if (!path.isAbsolute(dirPath)) {
      console.error(`--add-dir path must be absolute: "${dirPath}"`)
      process.exitCode = 1
      return
    }
  }

  // Resolve git identity locally so we can prompt when it's missing.
  // The daemon gets the already-resolved pair.
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

  const tool: AgentTool = options.tool ?? 'claude'

  const client = await getRpcClient()
  const res = await client.session.create.$post({
    json: {
      project: projectSlug,
      tool,
      addDir: options.addDir,
      addDirRw: options.addDirRw,
      gitUser,
    },
  })
  if (!res.ok) throw await toClientError(res)

  const result = await consumeSessionCreateStream(res)

  const { sessionId, containerName } = result
  if (!sessionId || !containerName) {
    console.error('Daemon did not return a sessionId/containerName.')
    process.exitCode = 1
    return
  }

  // Test-only hook: e2e-cli tests drive sessions without a TTY, where
  // `podman exec -it` hangs waiting for terminal capabilities. Setting
  // this env var returns after provisioning and lets the test drive the
  // container directly via `podman exec`.
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
      // Container or tmux session was killed (e.g. ctrl-b k) — the
      // daemon's background loop will reap the dead container.
    }
  }

  return sessionId
}
