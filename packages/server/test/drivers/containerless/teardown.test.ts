import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { setDataDir } from '@yaac/shared/paths'
import { WorkspaceExecError } from '#drivers/contract'

import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
const mockKillPids = vi.hoisted(() => vi.fn())
const mockDescendants = vi.hoisted(() => vi.fn())
const mockIsSshAgentFor = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
  killPids: mockKillPids,
  descendantPids: mockDescendants,
  isSshAgentFor: mockIsSshAgentFor,
}))
import {
  destroyWorkspace,
  detachedTeardownCommand,
} from '#drivers/containerless/teardown'
import { containerlessJobName, containerlessWorkspacePaths } from '#drivers/containerless/paths'
import {
  _resetRegistryForTests,
  listWorkspaces,
  observeLiveness,
  rememberWorkspace,
  restoreWorkspace,
} from '#drivers/containerless/registry'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const TARGET = {
  projectSlug: 'demo',
  workspaceId: UUID,
  unitName: containerlessJobName('demo', UUID),
}
let dataDir: string

/** A registered workspace with a known tmux pid, as a launch leaves one.
 *  `sshAgentPid` is what a project with an SSH remote also leaves. */
function registered(extra: { sshAgentPid?: number } = {}): void {
  rememberWorkspace({
    projectSlug: 'demo', worktreeId: UUID, tool: 'claude', mode: 'tui',
    prewarm: false, createdAtMs: 1_000, tmuxPid: 4242, ...extra,
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
  mockIsSshAgentFor.mockReset()
  mockIsSshAgentFor.mockResolvedValue(true)
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

describe('destroyWorkspace ssh-agent', () => {
  it('ends the agent holding the worktree’s key, and removes its socket', async () => {
    // The agent is not a descendant of the tmux server — it was started
    // beside it, detached — so nothing else in the teardown would reach it,
    // and a surviving one holds a private key for a worktree that is gone.
    registered({ sshAgentPid: 777 })
    const paths = containerlessWorkspacePaths(TARGET.unitName)
    fs.mkdirSync(path.dirname(paths.sshAgentSock), { recursive: true })
    fs.writeFileSync(paths.sshAgentSock, '')

    await destroyWorkspace(TARGET)

    expect(mockKillPids).toHaveBeenCalledWith([777], 'SIGTERM')
    expect(fs.existsSync(paths.sshAgentSock)).toBe(false)
  })

  it('signals it for a workspace it never saw running, too', async () => {
    // NOT gated on having seen it running, unlike the stray sweep: a
    // worktree whose tmux died while the host stayed up would otherwise
    // leave an agent holding the private key until reboot — the failure the
    // per-worktree agent exists to prevent.
    restoreWorkspace({
      projectSlug: 'demo', worktreeId: UUID, tool: 'claude', mode: 'tui',
      prewarm: false, createdAtMs: 1_000, tmuxPid: 4242, sshAgentPid: 777,
    }, false, { reason: 'agent-exited' })

    await destroyWorkspace(TARGET)

    expect(mockKillPids).toHaveBeenCalledWith([777], 'SIGTERM')
  })

  it('leaves a recycled pid alone', async () => {
    // What replaces the running-gate: the pid is checked against the socket
    // path in the agent's own argv, so a number that now names something
    // else is not signalled.
    registered({ sshAgentPid: 777 })
    mockIsSshAgentFor.mockResolvedValue(false)

    await destroyWorkspace(TARGET)

    expect(mockKillPids).not.toHaveBeenCalledWith([777], 'SIGTERM')
  })

  it('has nothing to signal for a project with no SSH remote', async () => {
    registered()

    await destroyWorkspace(TARGET)

    const signalled = mockKillPids.mock.calls.flatMap(([pids]) => pids as number[])
    expect(signalled).not.toContain(777)
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

  it('removes the agent socket alongside the tmux one', () => {
    const cmd = detachedTeardownCommand(TARGET)
    expect(cmd).toMatch(/rm -f '[^']*-ssh\.sock'/)
  })

  /**
   * RUN the script rather than match its text.
   *
   * The agent is found by its socket path in `ps` output, because this runs
   * detached with no registry to read — and the failure that shape invites is
   * the script matching ITSELF: `sh -c` puts the whole script in the shell's
   * own argv, so a naive pipeline kills the teardown shell and skips every
   * command after it. No assertion about the command STRING catches that, so
   * these run the real thing against a stubbed `ps` and a stubbed `kill`.
   */
  describe('run against a stubbed ps', () => {
    let binDir: string
    let killLog: string

    beforeEach(() => {
      binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-teardown-bin-'))
      killLog = path.join(binDir, 'killed.txt')
      // `ps` reports one real ssh-agent for this workspace, plus a decoy for
      // another worktree that must be left alone.
      const paths = containerlessWorkspacePaths(TARGET.unitName)
      fs.writeFileSync(path.join(binDir, 'ps'), [
        '#!/bin/sh',
        // The shell running the teardown script is in `ps` output for real;
        // this stub adds it back explicitly so the self-match is reachable.
        'echo "  4242 ssh-agent -D -a ' + paths.sshAgentSock + '"',
        'echo "  9999 ssh-agent -D -a /tmp/other/xyz-ssh.sock"',
        '/bin/ps -eo pid=,args=',
      ].join('\n') + '\n', { mode: 0o755 })
      fs.writeFileSync(path.join(binDir, 'kill'), [
        '#!/bin/sh',
        `for pid in "$@"; do echo "$pid" >> ${killLog}; done`,
      ].join('\n') + '\n', { mode: 0o755 })
    })

    afterEach(() => {
      fs.rmSync(binDir, { recursive: true, force: true })
    })

    /** Run the script with the stubs first on PATH; answer what it killed. */
    function runScript(extra = ''): { killed: string[]; marker: boolean } {
      const marker = path.join(binDir, 'reached-the-end')
      const script = `${detachedTeardownCommand(TARGET)}; touch ${marker}${extra}`
      spawnSync('sh', ['-c', script], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      })
      const killed = fs.existsSync(killLog)
        ? fs.readFileSync(killLog, 'utf8').split('\n').filter((l) => l.trim() !== '')
        : []
      return { killed, marker: fs.existsSync(marker) }
    }

    it('kills this workspace’s agent and nobody else’s', () => {
      const { killed } = runScript()
      expect(killed).toEqual(['4242'])
    })

    it('does not kill its own shell, so the rest of the teardown runs', () => {
      // The bug this guards: `sh -c` puts the script in the shell's argv, so
      // a pipeline matching "ssh-agent" and the socket path finds itself,
      // kills the shell, and silently skips the tmux kill and every rm.
      const { killed, marker } = runScript()
      expect(marker).toBe(true)
      expect(killed).not.toContain(String(process.pid))
      // Exactly one pid, so nothing incidental matched either.
      expect(killed).toHaveLength(1)
    })
  })
})
