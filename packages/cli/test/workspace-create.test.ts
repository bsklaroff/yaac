import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { agentOptionArg, workspaceCreate, type WorkspaceCreateOptions } from '#commands/workspace-create'
import { serveProjects, startFakeApi, type FakeApi } from './fake-api'

/*
 * What `yaac workspace create` refuses by itself, before it asks the server
 * for anything: every combination of options that cannot go together. The
 * e2e suites run one of each kind through the real CLI, and the paths that
 * do reach the server.
 */
let api: FakeApi

beforeAll(async () => {
  api = await startFakeApi()
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
})

describe('workspaceCreate', () => {
  it('refuses options that cannot go together, asking the server nothing', async () => {
    const refused = async (project: string | undefined, options: WorkspaceCreateOptions, message: string): Promise<void> => {
      await expect(workspaceCreate(project, options), message).rejects.toThrow(message)
    }

    await refused(undefined, {}, 'Name the project to create the workspace in, or --workspace to start an agent in a running one.')
    await refused('p', { workspace: 'abc123' }, 'Give a project or --workspace, not both')
    await refused('p', { resume: 'conv-1' }, '--resume needs --workspace: a conversation resumes in the workspace that holds it.')

    // An agent in a running workspace takes none of a workspace's settings.
    const workspaceSettings: Array<[string, WorkspaceCreateOptions]> = [
      ['--branch', { branch: 'main' }], ['--repo', { repo: [{ repo: 'lib' }] }], ['--no-repos', { repos: false }],
      ['--nested', { nested: true }], ['--no-nested', { nested: false }], ['--group', { group: 'g' }],
      ['--timeout', { timeout: '1h' }], ['--start-at', { startAt: '10:00' }], ['--start-in', { startIn: '5m' }],
      ['--volume', { volume: 'v' }], ['--commit', { commit: 'a'.repeat(40) }], ['--steps', { steps: 'steps.json' }],
      ['--no-steps', { steps: false }], ['--workflow', { workflow: 'ci' }], ['--non-interactive', { nonInteractive: true }],
      ['--wait', { wait: true }], ['--use-image', { useImage: 'tiny' }], ['--await-build', { awaitBuild: true }],
    ]
    for (const [flag, options] of workspaceSettings) {
      await refused(undefined, { workspace: 'abc123', ...options },
        `${flag} is a workspace's setting, which --workspace (an agent in a running one) does not take.`)
    }
    await refused(undefined, { workspace: 'abc123', agent: false }, '--no-agent starts a new workspace; it does not take --workspace.')

    // A workspace with no agent takes none of an agent's
    // options; a non-interactive one may still be scheduled.
    const agentOptions: Array<[string, WorkspaceCreateOptions]> = [
      ['--tool', { tool: 'claude' }], ['--model', { model: 'opus' }], ['--effort', { effort: 'high' }],
      ['--agent-option', { agentOption: { idleCompaction: true } }], ['--mode', { mode: 'acp' }],
      ['--permission-mode', { permissionMode: 'plan' }], ['--prompt', { prompt: 'go' }], ['--prompt-file', { promptFile: 'brief.md' }],
    ]
    const scheduling: Array<[string, WorkspaceCreateOptions]> = [['--start-at', { startAt: '10:00' }], ['--start-in', { startIn: '5m' }]]
    for (const [flag, options] of [...agentOptions, ...scheduling]) {
      await refused('p', { agent: false, ...options }, `--no-agent does not take ${flag}: a workspace with no agent runs none.`)
    }
    for (const [flag, options] of agentOptions) {
      await refused('p', { nonInteractive: true, steps: 'steps.json', ...options },
        `--non-interactive does not take ${flag}: a workspace with no agent runs none.`)
    }
    await refused('p', { agent: false, nonInteractive: true }, '--non-interactive already starts no agent; drop --no-agent.')

    // What a non-interactive workspace runs, and what waits for it.
    await refused('p', { steps: 'steps.json', workflow: 'ci' }, 'Give --steps or --workflow, not both.')
    await refused('p', { nonInteractive: true }, '--non-interactive runs the steps --steps <file> or --workflow names')
    await refused('p', { nonInteractive: true, steps: false }, '--non-interactive runs the steps --steps <file> or --workflow names')
    await refused('p', { wait: true, prompt: 'x' }, '--wait goes with --non-interactive: only it ends by itself.')
    await refused('p', { nonInteractive: true, steps: 'steps.json', wait: true, startIn: '1h' },
      '--wait waits for a workspace started now; a scheduled one starts later.')
    await refused('p', { prompt: 'x', startAt: '10:00', startIn: '5m' }, 'Give --start-at or --start-in, not both.')
    await refused('p', { prompt: 'x', startIn: '30s' }, 'whole minutes')

    // A scheduled create launches whatever image is built when it starts,
    // so it has no build to wait for.
    for (const [, options] of scheduling) {
      for (const image of [{}, { useImage: 'tiny' }]) {
        await refused('p', { prompt: 'x', awaitBuild: true, ...image, ...options },
          '--await-build waits for a create now; a scheduled one launches the image built when it starts.')
      }
    }

    expect(api.requests).toEqual([])
  })

  // These come after the project or workspace is resolved, but before
  // anything is created, for a new workspace and an agent in a running one.
  it('refuses a prompt given twice, or one that is empty or unreadable, creating nothing', async () => {
    api.reset()
    serveProjects(api, [['id-p', 'p']])
    api.on('GET /api/workspace/w1', { json: { workspaceId: 'w1' } })
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-prompt-'))
    const empty = path.join(dir, 'empty.md')
    await fs.writeFile(empty, '')
    const stdin = vi.spyOn(process, 'stdin', 'get').mockImplementation(() => Readable.from([]) as typeof process.stdin)
    try {
      const refusals: Array<[WorkspaceCreateOptions, string]> = [
        [{ prompt: 'x', promptFile: empty }, 'Give the prompt with --prompt or --prompt-file, not both.'],
        [{ promptFile: empty }, `The prompt from ${empty} is empty.`],
        [{ promptFile: `${empty}.missing` }, `Cannot read the prompt from ${empty}.missing: `],
        [{ prompt: '-' }, 'The prompt from stdin is empty.'],
      ]
      for (const [options, message] of refusals) {
        await expect(workspaceCreate('p', options), message).rejects.toThrow(message)
        await expect(workspaceCreate(undefined, { workspace: 'w1', ...options }), message).rejects.toThrow(message)
      }
    } finally {
      stdin.mockRestore()
      await fs.rm(dir, { recursive: true, force: true })
    }
    expect(api.requests.map((r) => r.route)).not.toContain('POST /api/workspace/create')
    expect(api.requests.map((r) => r.route)).not.toContain('POST /api/workspace/w1/sessions')
  })
})

describe('agentOptionArg', () => {
  it('gathers each <name>=<on|off>, and refuses any other shape or name', () => {
    expect(agentOptionArg('idle-compaction=on')).toEqual({ idleCompaction: true })
    expect(agentOptionArg('idle-cache-warming=off', { idleCompaction: true })).toEqual({ idleCompaction: true, idleCacheWarming: false })
    for (const bad of ['idle-compaction', 'idle-compaction=yes', 'idle-compaction=on=off', 'nap=on']) {
      expect(() => agentOptionArg(bad), bad).toThrow('expected <name>=<on|off>, with a name of idle-compaction, idle-cache-warming')
    }
  })
})
