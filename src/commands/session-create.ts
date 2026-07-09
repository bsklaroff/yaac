import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import simpleGit from 'simple-git'
import { getRpcClient, toClientError } from '@/commands/rpc'
import { interactiveExecArgs } from '@/lib/k8s/exec'
import { getGitUserConfig } from '@/shared/git'
import { consumeNdjsonStream } from '@/shared/ndjson'
import { CONTAINER_TMUX_SOCK, getProjectsDir } from '@/shared/paths'
import { testEnv } from '@/shared/env'
import type { AgentTool } from '@/shared/types'

export interface SessionCreateOptions {
  addDir?: string[]
  addDirRw?: string[]
  tool?: AgentTool
}

interface SessionCreateResult {
  sessionId?: string
  jobName?: string
}

/**
 * CLI entry point for `yaac session create`. Prompts for git identity
 * when the global config is missing, then hands provisioning off to
 * the daemon via `POST /session/create`. The daemon owns the worktree,
 * Job, and port forwarders for the session's lifetime; the CLI just
 * attaches the user's terminal to the resulting tmux session.
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

  // Tool is sent only when explicit (--tool). The daemon resolves the
  // configured default (yaac tool set) when omitted, so a bare create matches
  // the prewarmed spare the daemon keeps for that tool.
  const client = await getRpcClient()
  const res = await client.session.create.$post({
    json: {
      project: projectSlug,
      tool: options.tool,
      addDir: options.addDir,
      addDirRw: options.addDirRw,
      gitUser,
    },
  })
  if (!res.ok) throw await toClientError(res)

  const result = await consumeNdjsonStream<SessionCreateResult>(res)

  const { sessionId, jobName } = result
  if (!sessionId || !jobName) {
    console.error('Daemon did not return a sessionId/jobName.')
    process.exitCode = 1
    return
  }

  // Test-only hook: e2e-cli tests drive sessions without a TTY, where
  // `kubectl exec -it` hangs waiting for terminal capabilities. Setting
  // this env var returns after provisioning and lets the test drive the
  // container directly via `kubectl exec`.
  if (!testEnv.e2eNoAttach) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('kubectl', interactiveExecArgs(jobName, ['tmux', '-S', CONTAINER_TMUX_SOCK, 'attach-session', '-t', 'yaac']), {
          stdio: 'inherit',
        })
        child.on('close', () => resolve())
        child.on('error', reject)
      })
    } catch {
      // Job or tmux session was killed (e.g. ctrl-b k) — the daemon's
      // background loop will reap the dead session.
    }
  }

  return sessionId
}
