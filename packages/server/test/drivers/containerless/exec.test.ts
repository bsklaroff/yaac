import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'
import { worktreeDir } from '@yaac/shared/project-paths'
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
  getWorktreeChanges,
} from '#drivers/containerless/exec'
import { containerlessJobName } from '#drivers/containerless/paths'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const JOB = containerlessJobName('demo', UUID)
let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-exec-'))
  setDataDir(dataDir)
  mockRunHost.mockReset()
  mockRunHost.mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('execInWorkspace', () => {
  it('runs the command in the worktree checkout, one shell pass', async () => {
    await execInWorkspace(JOB, 'tmux -S /x has-session -t yaac')
    const [argv, opts] = mockRunHost.mock.calls[0] as [string[], { cwd: string }]
    // One shell pass is the contract every caller writes command text
    // against — `sh -c <cmd>`, not a split argv.
    expect(argv).toEqual(['sh', '-c', 'tmux -S /x has-session -t yaac'])
    expect(opts.cwd).toBe(worktreeDir('demo', UUID))
  })

  it('passes a nonzero exit through as the verdict it is', async () => {
    // Load-bearing: the stale reaper reads a WorkspaceExecError from a tmux
    // probe as proof the worktree is dead and tears it down.
    mockRunHost.mockRejectedValue(new WorkspaceExecError('command exited 1', 1, '', 'no server'))
    await expect(execInWorkspace(JOB, 'false')).rejects.toBeInstanceOf(WorkspaceExecError)
  })

  it('never turns a transport failure into a verdict about the workspace', async () => {
    // A spawn failure proves nothing about the worktree; reported as a
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

describe('getWorktreeChanges', () => {
  it('computes the diff with host git in the checkout, against its own index', async () => {
    mockRunHost.mockResolvedValue({
      stdout: 'BASE abc123\nFORK 1\n@@NUMSTAT@@\n@@NAMESTATUS@@\n@@OK@@\n@@DIFF@@\n',
      stderr: '',
    })
    const changes = await getWorktreeChanges(JOB)
    expect(changes.base).toBe('abc123')
    const [argv, opts] = mockRunHost.mock.calls[0] as [string[], { cwd: string }]
    const script = argv[2]
    // No path translation and no exec into anything: the checkout the agent
    // uses is the one the server made.
    expect(script).toContain(worktreeDir('demo', UUID))
    expect(opts.cwd).toBe(worktreeDir('demo', UUID))
    // Never the agent's real index — a stable private one, so git's stat
    // cache makes each poll incremental.
    expect(script).toContain('yaac-changes.idx')
    expect(script).toContain(`exit ${String(CHANGES_BASE_UNRESOLVED)}`)
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
