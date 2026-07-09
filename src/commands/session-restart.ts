import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import simpleGit from 'simple-git'
import { getRpcClient, toClientError } from '@/commands/rpc'
import { interactiveExecArgs } from '@/lib/k8s/exec'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import { getGitUserConfig } from '@/shared/git'
import { consumeNdjsonStream } from '@/shared/ndjson'
import { testEnv } from '@/shared/env'

export interface SessionRestartOptions {
  addDir?: string[]
  addDirRw?: string[]
}

interface SessionRestartResult {
  sessionId?: string
  jobName?: string
}

/**
 * CLI entry for `yaac session restart <sessionId>`. Resolves git identity
 * up-front (prompting when missing), then hands the restart off to the
 * daemon. The daemon tears down the old Job, keeps the worktree, and
 * spins up a fresh Job running the agent with `--resume`.
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

  const result = await consumeNdjsonStream<SessionRestartResult>(res)

  const { sessionId: restartedId, jobName } = result
  if (!restartedId || !jobName) {
    console.error('Daemon did not return a sessionId/jobName.')
    process.exitCode = 1
    return
  }

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
      // Job or tmux session was killed — reaper will clean up.
    }
  }

  return restartedId
}
