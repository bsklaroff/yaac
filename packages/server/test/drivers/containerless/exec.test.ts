import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'
import { workspaceDir } from '@yaac/shared/project-paths'
import { WorkspaceExecError } from '#drivers/contract'

import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
}))
import { execInWorkspace, runInStoppedCheckout } from '#drivers/containerless/exec'
import { containerlessJobName, containerlessStateDir } from '#drivers/containerless/paths'
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

/** The environment the first host command ran with. */
const ranWith = (): NodeJS.ProcessEnv =>
  (mockRunHost.mock.calls[0] as [string[], { env: NodeJS.ProcessEnv }])[1].env

describe('execInWorkspace', () => {
  it('runs the command in the workspace checkout, one shell pass, stopped by its signal', async () => {
    const abort = new AbortController()
    await execInWorkspace(JOB, 'tmux -S /x has-session -t yaac', { signal: abort.signal })
    const [argv, opts] = mockRunHost.mock.calls[0] as [string[], { cwd: string; signal: AbortSignal }]
    // Callers write command text for one `sh -c` pass, not a split argv.
    expect(argv).toEqual(['sh', '-c', 'tmux -S /x has-session -t yaac'])
    expect(opts.cwd).toBe(workspaceDir('demo', UUID))
    expect(opts.signal).toBe(abort.signal)
  })

  it('runs with the launch\'s own entries after a restart, over the workspace floor', async () => {
    // After a restart, only the marker on disk is available.
    await writeMarker({
      projectId: 'demo', workspaceId: UUID, tool: 'opencode', mode: 'tui',
      createdAtMs: 1_000,
      launchEnv: { CODEX_HOME: '/projects/demo/codex', PROJECT_SETTING: 'on' },
    })
    for (const m of await readMarkers()) restoreWorkspace(m, true, { reason: 'pod-stopped' })
    vi.stubEnv('YAAC_SERVER_WIRING', 'server-only')

    await execInWorkspace(JOB, 'opencode api --standalone session.list')
    const env = ranWith()
    // `opencode` is the workspace's wrapper, first on PATH, so `opencode api`
    // lists the workspace's sessions rather than the host user's.
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(containerlessStateDir('demo', UUID), 'bin'))
    expect(env).toMatchObject({ CODEX_HOME: '/projects/demo/codex', PROJECT_SETTING: 'on' })
    expect(env.YAAC_SERVER_WIRING).toBeUndefined()
  })

  it('never falls back to the server\'s own environment', async () => {
    // No marker: a workspace the registry has forgotten.
    vi.stubEnv('YAAC_SERVER_WIRING', 'server-only')
    vi.stubEnv('HOME', '/home/server-user')
    vi.stubEnv('CODEX_HOME', '/home/server-user/.codex')
    await execInWorkspace(JOB, 'true')
    const env = ranWith()
    const state = containerlessStateDir('demo', UUID)
    // The user's own HOME, but the workspace's git config.
    expect(env.HOME).toBe('/home/server-user')
    expect(env.GIT_CONFIG_GLOBAL).toBe(path.join(state, 'gitconfig'))
    expect(env.YAAC_SERVER_WIRING).toBeUndefined()
    // A tool-home override would point the command at the host's config.
    expect(env.CODEX_HOME).toBeUndefined()
    // The workspace still inherits the user's toolchain, behind its own.
    expect(env.PATH).toContain(path.join(state, 'bin'))
    expect(env.PATH).toContain(process.env.PATH ?? '')
  })

  it('passes a nonzero exit through as the verdict it is', async () => {
    // The stale reaper treats a WorkspaceExecError from a tmux probe as
    // proof the workspace is dead and tears it down.
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
})

describe('runInStoppedCheckout', () => {
  it('runs the script on the host in the checkout, its path first, as the server\'s user', async () => {
    await runInStoppedCheckout({ projectId: 'demo', workspaceId: UUID }, 'echo "$@"', ['.env'], { timeoutMs: 60_000 })
    const [argv, opts] = mockRunHost.mock.calls[0] as [string[], { cwd: string; timeoutMs: number; env?: unknown }]
    expect(argv).toEqual(['sh', '-c', 'echo "$@"', 'sh', workspaceDir('demo', UUID), '.env'])
    expect(opts).toEqual({ cwd: workspaceDir('demo', UUID), timeoutMs: 60_000 })
  })

  it('rejects when the script exits nonzero', async () => {
    mockRunHost.mockRejectedValueOnce(new WorkspaceExecError('exit 1', 1, '', 'failed to remove'))
    await expect(runInStoppedCheckout({ projectId: 'demo', workspaceId: UUID }, 'false', [], { timeoutMs: 60_000 }))
      .rejects.toThrow('exit 1')
  })
})
