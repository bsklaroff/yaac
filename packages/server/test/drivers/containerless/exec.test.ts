import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'
import { workspaceDir } from '@yaac/shared/project-paths'
import { CHANGES_BASE_UNRESOLVED, WorkspaceExecError } from '#drivers/contract'

import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
}))
import {
  awaitAgentTransport,
  execInWorkspace,
  getWorkspaceChanges,
} from '#drivers/containerless/exec'
import { containerlessJobName, workspaceHome } from '#drivers/containerless/paths'
import {
  _resetRegistryForTests,
  readMarkers,
  restoreWorkspace,
  writeMarker,
} from '#drivers/containerless/registry'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const JOB = containerlessJobName('demo', UUID)
let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-exec-'))
  setDataDir(dataDir)
  _resetRegistryForTests()
  mockRunHost.mockReset()
  mockRunHost.mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** The environment the one host command ran with. */
const ranWith = (): NodeJS.ProcessEnv =>
  (mockRunHost.mock.calls[0] as [string[], { env: NodeJS.ProcessEnv }])[1].env

describe('execInWorkspace', () => {
  it('runs the command in the workspace checkout, one shell pass', async () => {
    await execInWorkspace(JOB, 'tmux -S /x has-session -t yaac')
    const [argv, opts] = mockRunHost.mock.calls[0] as [string[], { cwd: string }]
    // One shell pass is the contract every caller writes command text
    // against — `sh -c <cmd>`, not a split argv.
    expect(argv).toEqual(['sh', '-c', 'tmux -S /x has-session -t yaac'])
    expect(opts.cwd).toBe(workspaceDir('demo', UUID))
  })

  it('runs with the launch\'s own entries after a restart, over the workspace floor', async () => {
    // What a restarted server has: the marker on disk and nothing in memory.
    await writeMarker({
      projectSlug: 'demo', workspaceId: UUID, tool: 'opencode', mode: 'tui',
      prewarm: false, createdAtMs: 1_000,
      launchEnv: { CODEX_HOME: '/projects/demo/codex', PROJECT_SETTING: 'on' },
    })
    for (const m of await readMarkers()) restoreWorkspace(m, true, { reason: 'pod-stopped' })
    vi.stubEnv('YAAC_SERVER_WIRING', 'server-only')

    await execInWorkspace(JOB, 'opencode api --standalone session.list')
    const env = ranWith()
    // `opencode api` reads its data under HOME: the host's would list the
    // host user's sessions instead of this workspace's.
    expect(env.HOME).toBe(workspaceHome('demo', UUID))
    expect(env).toMatchObject({ CODEX_HOME: '/projects/demo/codex', PROJECT_SETTING: 'on' })
    expect(env.YAAC_SERVER_WIRING).toBeUndefined()
  })

  it('never falls back to the server\'s own environment', async () => {
    // A marker from before it carried one, or no marker at all.
    vi.stubEnv('YAAC_SERVER_WIRING', 'server-only')
    vi.stubEnv('HOME', '/home/server-user')
    vi.stubEnv('CODEX_HOME', '/home/server-user/.codex')
    await execInWorkspace(JOB, 'true')
    const env = ranWith()
    const home = workspaceHome('demo', UUID)
    expect(env.HOME).toBe(home)
    expect(env.GIT_CONFIG_GLOBAL).toBe(path.join(home, '.gitconfig'))
    expect(env.YAAC_SERVER_WIRING).toBeUndefined()
    // A tool-home override would point the command at the host's config.
    expect(env.CODEX_HOME).toBeUndefined()
    // Still the user's toolchain — that is what the workspace inherits.
    expect(env.PATH).toContain(path.join(home, '.local', 'bin'))
  })

  it('passes a nonzero exit through as the verdict it is', async () => {
    // Load-bearing: the stale reaper reads a WorkspaceExecError from a tmux
    // probe as proof the workspace is dead and tears it down.
    mockRunHost.mockRejectedValue(new WorkspaceExecError('command exited 1', 1, '', 'no server'))
    await expect(execInWorkspace(JOB, 'false')).rejects.toBeInstanceOf(WorkspaceExecError)
  })

  it('never turns a transport failure into a verdict about the workspace', async () => {
    // A spawn failure proves nothing about the workspace; reported as a
    // WorkspaceExecError it would reap a live one.
    mockRunHost.mockRejectedValue(new Error('ENOENT: tmux not found'))
    const err: unknown = await execInWorkspace(JOB, 'tmux').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(WorkspaceExecError)
  })

  it('does not re-run a command that already reported its verdict', async () => {
    mockRunHost.mockRejectedValue(new WorkspaceExecError('exited 1', 1, '', ''))
    await execInWorkspace(JOB, 'false', { maxAttempts: 3 }).catch(() => { /* expected */ })
    // There is no transport between here and the workspace worth retrying,
    // and re-running would just repeat the same failure.
    expect(mockRunHost).toHaveBeenCalledTimes(1)
  })
})

describe('getWorkspaceChanges', () => {
  it('computes the diff with host git in the checkout, against its own index', async () => {
    mockRunHost.mockResolvedValue({
      stdout: 'BASE abc123\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n@@OK@@\n@@DIFF@@\n',
      stderr: '',
    })
    const changes = await getWorkspaceChanges(JOB)
    expect(changes.base).toBe('abc123')
    const [argv, opts] = mockRunHost.mock.calls[0] as [string[], { cwd: string }]
    const script = argv[2]
    // No path translation and no exec into anything: the checkout the agent
    // uses is the one the server made.
    expect(script).toContain(workspaceDir('demo', UUID))
    expect(opts.cwd).toBe(workspaceDir('demo', UUID))
    // Never the agent's real index — a stable private one, so git's stat
    // cache makes each poll incremental.
    expect(script).toContain('yaac-changes.idx')
    expect(script).toContain(`exit ${String(CHANGES_BASE_UNRESOLVED)}`)
    // The workspace's git config, not the server user's.
    expect(ranWith().GIT_CONFIG_GLOBAL).toBe(path.join(workspaceHome('demo', UUID), '.gitconfig'))
  })
})

describe('awaitAgentTransport', () => {
  it('resolves once the workspace tmux answers', async () => {
    await expect(awaitAgentTransport(JOB, { timeoutMs: 1_000 })).resolves.toBeUndefined()
    expect((mockRunHost.mock.calls[0] as [string[]])[0]).toContain('has-session')
  })

  it('rejects when it never does, leaving the caller to decide', async () => {
    mockRunHost.mockRejectedValue(new Error('no server running'))
    await expect(awaitAgentTransport(JOB, { timeoutMs: 50 }))
      .rejects.toThrow(/did not answer within the deadline/)
  })
})
