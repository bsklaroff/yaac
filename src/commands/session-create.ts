import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { execSync } from 'node:child_process'
import simpleGit from 'simple-git'
import { ensureContainerRuntime, podman } from '@/lib/podman'
import { ensureImage } from '@/lib/image-builder'
import { repoDir, claudeDir, claudeJsonFile, worktreeDir, worktreesDir, projectDir } from '@/lib/paths'
import { addWorktree, getDefaultBranch, fetchAndPullDefault, getGitUserConfig } from '@/lib/git'
import { loadProjectConfig } from '@/lib/config'
import { buildRulesFromConfig } from '@/lib/secret-conventions'
import { proxyClient } from '@/lib/proxy-client'
import type { YaacConfig } from '@/types'

export function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''")
}

export interface SessionCreateOptions {
  prompt?: string
}

export async function sessionCreate(projectSlug: string, options: SessionCreateOptions): Promise<void> {
  // Verify project exists
  try {
    await fs.access(projectDir(projectSlug))
  } catch {
    console.error(`Project "${projectSlug}" not found. Run "yaac project list" to see available projects.`)
    process.exitCode = 1
    return
  }

  await ensureContainerRuntime()

  // Ensure git user identity is configured (needed for commits inside container)
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

  console.log('Ensuring container images are built...')
  const imageName = await ensureImage(projectSlug)

  const sessionId = crypto.randomBytes(4).toString('hex')
  const repo = repoDir(projectSlug)
  const wtDir = worktreeDir(projectSlug, sessionId)

  // Fetch latest from remote before branching
  console.log('Fetching latest from remote...')
  try {
    await fetchAndPullDefault(repo)
  } catch {
    console.warn('Warning: could not fetch from remote, using local state')
  }

  // Create worktree
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  const defaultBranch = await getDefaultBranch(repo)
  console.log(`Creating worktree from ${defaultBranch}...`)
  await addWorktree(repo, wtDir, `yaac/${sessionId}`)

  // Load project config
  const config: YaacConfig = await loadProjectConfig(repo) ?? {}

  // Build container env
  const env: string[] = ['TERM=xterm-256color']

  // Passthrough env vars
  if (config.envPassthrough) {
    for (const name of config.envPassthrough) {
      const val = process.env[name]
      if (val !== undefined) {
        env.push(`${name}=${val}`)
      }
    }
  }

  // Proxy setup
  let proxyToken: string | null = null
  const hasSecretProxy = config.envSecretProxy && Object.keys(config.envSecretProxy).length > 0
  let networkMode = 'podman'

  if (hasSecretProxy) {
    console.log('Starting proxy sidecar...')
    await proxyClient.ensureRunning()

    const rules = buildRulesFromConfig(config.envSecretProxy!, process.env)
    await proxyClient.updateProjectRules(projectSlug, rules)

    proxyToken = proxyClient.generateSessionToken()
    await proxyClient.registerSession(proxyToken, projectSlug)

    // Add proxy env vars
    env.push(...proxyClient.getProxyEnv(proxyToken))

    // Add placeholder values for proxied secrets so tools detect them
    for (const name of Object.keys(config.envSecretProxy!)) {
      if (process.env[name]) {
        env.push(`${name}=placeholder`)
      }
    }

    networkMode = proxyClient.network
  }

  const containerName = `yaac-${projectSlug}-${sessionId}`
  const claude = claudeDir(projectSlug)
  const claudeJson = claudeJsonFile(projectSlug)

  // Ensure claude.json exists so Podman mounts it as a file, not a directory
  try {
    await fs.access(claudeJson)
  } catch {
    await fs.writeFile(claudeJson, '{}')
  }

  console.log(`Creating container ${containerName}...`)
  const container = await podman.createContainer({
    Image: imageName,
    name: containerName,
    Labels: {
      'yaac.managed': 'true',
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
    },
    Env: env,
    HostConfig: {
      Binds: [
        `${wtDir}:/workspace:Z`,
        `${repo}/.git:/repo/.git:Z`,
        `${claude}:/home/yaac/.claude:Z`,
        `${claudeJson}:/home/yaac/.claude.json:Z`,
      ],
      NetworkMode: networkMode,
    },
  })

  await container.start()

  // Inject CA cert if using proxy
  if (hasSecretProxy) {
    const caCert = await proxyClient.getCaCert()
    execSync(`podman cp - ${containerName}:/tmp/proxy-ca.pem`, {
      input: caCert,
    })
  }

  // Fix worktree git pointers for in-container paths
  execSync(`podman exec ${containerName} sh -c "echo 'gitdir: /repo/.git/worktrees/${sessionId}' > /workspace/.git"`)
  execSync(`podman exec ${containerName} sh -c "echo '/workspace/.git' > /repo/.git/worktrees/${sessionId}/gitdir"`)

  // Configure git identity inside container
  execSync(`podman exec ${containerName} git config --global user.name '${shellEscape(gitUser.name)}'`)
  execSync(`podman exec ${containerName} git config --global user.email '${shellEscape(gitUser.email)}'`)

  // Start Claude Code in a tmux session
  const claudeCmd = options.prompt
    ? `claude --dangerously-skip-permissions -p ${shellEscape(options.prompt)}`
    : 'claude --dangerously-skip-permissions'
  console.log('Starting Claude Code...')
  execSync(`podman exec ${containerName} tmux -u new-session -d -s claude '${claudeCmd}'`, {
    stdio: 'pipe',
  })

  // Attach the user to the tmux session
  execSync(`podman exec -it ${containerName} tmux attach-session -t claude`, {
    stdio: 'inherit',
  })
}
