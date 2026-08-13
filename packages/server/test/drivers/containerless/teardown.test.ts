import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'
import { WorkspaceExecError } from '#drivers/contract'

import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
const mockKillPids = vi.hoisted(() => vi.fn())
const mockDescendants = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
  killPids: mockKillPids,
  descendantPids: mockDescendants,
}))
import {
  destroyWorkspace,
  detachedTeardownCommand,
} from '#drivers/containerless/teardown'
import { containerlessJobName } from '#drivers/containerless/paths'
import {
  _resetRegistryForTests,
  listWorkspaces,
  observeLiveness,
  rememberWorkspace,
} from '#drivers/containerless/registry'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const TARGET = {
  projectSlug: 'demo',
  workspaceId: UUID,
  unitName: containerlessJobName('demo', UUID),
}
let dataDir: string

/** A registered workspace with a known tmux pid, as a launch leaves one. */
function registered(): void {
  rememberWorkspace({
    projectSlug: 'demo', worktreeId: UUID, tool: 'claude', mode: 'tui',
    prewarm: false, createdAtMs: 1_000, tmuxPid: 4242,
  })
}

/** `has-session` fails (no session) but every other command succeeds — the
 *  ordinary "it really went away" shape. */
function sessionGone(): void {
  mockRunHost.mockImplementation((argv: string[]) =>
    argv.includes('has-session')
      ? Promise.reject(new WorkspaceExecError('exited 1', 1, '', 'no server running'))
      : Promise.resolve({ stdout: '', stderr: '' }))
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-teardown-'))
  setDataDir(dataDir)
  _resetRegistryForTests()
  mockRunHost.mockReset()
  mockKillPids.mockReset()
  mockDescendants.mockReset()
  mockDescendants.mockResolvedValue([4242])
  sessionGone()
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('destroyWorkspace', () => {
  it('kills the tmux server and confirms it is really gone', async () => {
    registered()
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)
    const argvs = mockRunHost.mock.calls.map((c) => c[0] as string[])
    expect(argvs.some((a) => a.includes('kill-server'))).toBe(true)
    // The caller deletes the checkout on this verdict, so it has to mean
    // "nothing is still writing there" rather than "we asked".
    expect(argvs.some((a) => a.includes('has-session'))).toBe(true)
    expect(listWorkspaces()).toHaveLength(0)
  })

  it('reports that it could not confirm when the session outlives the kill', async () => {
    registered()
    // has-session keeps succeeding: something is still running in there.
    // Driven on fake timers so the test does not sit out the real deadline,
    // which is deliberately generous for a wedged tmux.
    mockRunHost.mockResolvedValue({ stdout: '', stderr: '' })
    vi.useFakeTimers()
    try {
      const verdict = destroyWorkspace(TARGET)
      await vi.advanceTimersByTimeAsync(11_000)
      await expect(verdict).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never sweeps a dead workspace\'s recorded pid, which may have been recycled', async () => {
    // The marker's pid is advisory. This verb runs for dead workspaces too
    // (recovered dead after a host reboot, then stopped by the user), and
    // there that pid names some unrelated process of this user — sweeping
    // its tree would SIGTERM their editor.
    registered()
    observeLiveness(UUID, false, { reason: 'agent-exited' })
    mockDescendants.mockResolvedValue([4242, 5150])
    await destroyWorkspace(TARGET)
    expect(mockDescendants).not.toHaveBeenCalled()
    expect(mockKillPids).not.toHaveBeenCalled()
  })

  it('sweeps what a pane double-forked away from tmux', async () => {
    registered()
    // A dev server that escaped its process group is not tmux's to kill,
    // and on a shared host it would hold its port for good.
    mockDescendants.mockResolvedValue([4242, 5150, 5151])
    await destroyWorkspace(TARGET)
    expect(mockKillPids).toHaveBeenCalledWith([5150, 5151], 'SIGTERM')
  })

  it('is a no-op against a workspace that is already gone', async () => {
    // Teardowns are re-issued (the reaper, a resumed stop), so nothing here
    // may depend on there being something to tear down.
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)
  })

  it('keeps the marker when only the unit is being taken down', async () => {
    registered()
    // `unitOnly` runs between a create's launch attempts; removing the
    // marker there would hide a workspace the next attempt reuses.
    await destroyWorkspace(TARGET, { unitOnly: true })
    expect(listWorkspaces()).toHaveLength(1)
  })
})

describe('detachedTeardownCommand', () => {
  it('quotes every host path it composes into an rm -rf', () => {
    // Both paths come from the data dir and os.tmpdir(); a space in either
    // ("…/My Drive/yaac") would turn one removal into two of paths nobody
    // named. The caller composes its own quoted rm's into the same script.
    const cmd = detachedTeardownCommand(TARGET)
    expect(cmd).toMatch(/rm -rf '[^']*'/)
    expect(cmd).toMatch(/tmux -S '[^']*'/)
  })

  it('composes commands that tolerate having already run', () => {
    const cmd = detachedTeardownCommand(TARGET)
    // The whole script is re-issued when a teardown has to be resumed, and
    // a caller appends its own commands after it — so no step may abort it.
    expect(cmd).toContain('kill-server')
    expect(cmd).toContain('|| true')
    expect(cmd).toContain(UUID)
  })
})
