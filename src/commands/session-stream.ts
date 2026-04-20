import { spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import { getRpcClient, toClientError } from '@/lib/daemon-client'
import type { StreamOutcome } from '@/lib/daemon/stream-picker'
import type { AgentTool } from '@/types'

async function promptForProject(projects: string[], message: string): Promise<string | undefined> {
  if (projects.length === 0) return
  console.log(`\n${message}`)
  for (let i = 0; i < projects.length; i++) {
    console.log(`  ${i + 1}) ${projects[i]}`)
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('\nSelect a project (number): ')
    const index = parseInt(answer.trim(), 10) - 1
    if (index >= 0 && index < projects.length) return projects[index]
    console.log('Invalid selection.')
    return
  } finally {
    rl.close()
  }
}

export async function sessionStream(project?: string, tool?: AgentTool): Promise<void> {
  const client = await getRpcClient()
  const visited: string[] = []
  let lastVisited: string | undefined
  let lastProjectSlug: string | undefined
  let lastTool: AgentTool | undefined
  let lastOutcome: StreamOutcome = 'none'
  let currentProject = project

  while (true) {
    const res = await client.session.stream.next.$post({
      json: {
        project: currentProject,
        tool,
        visited,
        lastVisited,
        lastProjectSlug,
        lastTool,
        lastOutcome,
      },
    })
    if (!res.ok) throw await toClientError(res)
    const body = await res.json()

    if (body.done) {
      if (body.reason === 'closed_blank') {
        console.log('Closed blank session and found no waiting sessions. Exiting session stream.')
        return
      }
      if (body.reason === 'no_active') {
        console.log('No projects found. Add one with: yaac project add <remote-url>')
        return
      }
      // needs_project
      const candidates = body.candidates ?? []
      if (candidates.length === 1) {
        console.log(`Starting session stream for "${candidates[0]}"...`)
        currentProject = candidates[0]
        continue
      }
      const picked = await promptForProject(candidates, 'Select a project:')
      if (!picked) {
        console.log('No project selected. Exiting session stream.')
        return
      }
      currentProject = picked
      continue
    }

    visited.splice(0, visited.length, ...body.visited)
    lastVisited = body.lastVisited
    lastProjectSlug = body.projectSlug
    lastTool = body.tool
    currentProject = body.projectSlug

    const shortId = body.sessionId.slice(0, 8)
    console.log(`Attaching to session ${shortId} (project: ${body.projectSlug})...`)

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'podman',
        ['exec', '-it', body.containerName, 'tmux', 'attach-session', '-t', body.tmuxSession],
        { stdio: 'inherit' },
      )
      child.on('close', () => resolve())
      child.on('error', reject)
    })

    // The daemon re-evaluates outcomes on the next /stream/next call from
    // fresh state (tmux liveness, prompt presence), so the CLI only
    // needs to hint that the last session detached.
    lastOutcome = 'detached'
  }
}
