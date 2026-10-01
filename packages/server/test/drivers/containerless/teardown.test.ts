import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import { setDataDir } from '@yaac/shared/paths'
import { imageStoreDir, nodeLocalProjectPath } from '@yaac/shared/project-paths'
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
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  reapNodeLocal,
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

/** Register a workspace with a known tmux pid, as a launch does, plus an
 *  ssh-agent pid for a project with an SSH remote. */
function registered(extra: { sshAgentPid?: number } = {}): void {
  rememberWorkspace({
    projectSlug: 'demo', workspaceId: UUID, tool: 'claude', mode: 'tui',
    prewarm: false, createdAtMs: 1_000, launchEnv: {}, tmuxPid: 4242, ...extra,
  })
}

/** `has-session` fails (no session) and every other command succeeds: the
 *  normal "it is gone" case. */
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
    // The caller deletes the checkout on this result, so it must mean
    // nothing is still writing there.
    expect(argvs.some((a) => a.includes('has-session'))).toBe(true)
    expect(listWorkspaces()).toHaveLength(0)
  })

  it('reports that it could not confirm when the session outlives the kill', async () => {
    registered()
    // has-session keeps succeeding. Fake timers skip the real deadline,
    // which is long to allow for a wedged tmux.
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
    // A dead workspace (e.g. after a host reboot) may have a recycled pid
    // naming an unrelated user process, such as their editor.
    registered()
    observeLiveness(UUID, false, { reason: 'agent-exited' })
    mockDescendants.mockResolvedValue([4242, 5150])
    await destroyWorkspace(TARGET)
    expect(mockDescendants).not.toHaveBeenCalled()
    expect(mockKillPids).not.toHaveBeenCalled()
  })

  it('sweeps what a pane double-forked away from tmux', async () => {
    registered()
    // Killing tmux does not reach a dev server that left its process group,
    // and it would hold its port forever.
    mockDescendants.mockResolvedValue([4242, 5150, 5151])
    await destroyWorkspace(TARGET)
    expect(mockKillPids).toHaveBeenCalledWith([5150, 5151], 'SIGTERM')
  })

  it('is a no-op against a workspace that is already gone', async () => {
    // Teardowns are re-issued (the reaper, a resumed stop), so an absent
    // workspace must still succeed.
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)
  })

  it('keeps the marker when only the unit is being taken down', async () => {
    registered()
    // `unitOnly` runs between launch attempts; removing the marker would
    // hide a workspace the next attempt reuses.
    await destroyWorkspace(TARGET, { unitOnly: true })
    expect(listWorkspaces()).toHaveLength(1)
  })
})

describe('destroyWorkspace ssh-agent', () => {
  it('ends the agent holding the workspace’s key, and removes its socket', async () => {
    // The agent runs detached beside tmux, not under it, so only this step
    // stops it from holding a private key for a gone workspace.
    registered({ sshAgentPid: 777 })
    const paths = containerlessWorkspacePaths(TARGET.unitName)
    fs.mkdirSync(path.dirname(paths.sshAgentSock), { recursive: true })
    fs.writeFileSync(paths.sshAgentSock, '')

    await destroyWorkspace(TARGET)

    expect(mockKillPids).toHaveBeenCalledWith([777], 'SIGTERM')
    expect(fs.existsSync(paths.sshAgentSock)).toBe(false)
  })

  it('signals it for a workspace it never saw running, too', async () => {
    // Unlike the stray sweep, this does not require having seen the
    // workspace running; otherwise a workspace whose tmux died would leave
    // the agent holding its key until reboot.
    restoreWorkspace({
      projectSlug: 'demo', workspaceId: UUID, tool: 'claude', mode: 'tui',
      prewarm: false, createdAtMs: 1_000, launchEnv: {}, tmuxPid: 4242, sshAgentPid: 777,
    }, false, { reason: 'agent-exited' })

    await destroyWorkspace(TARGET)

    expect(mockKillPids).toHaveBeenCalledWith([777], 'SIGTERM')
  })

  it('leaves a recycled pid alone', async () => {
    // The pid is checked against the socket path in the agent's argv, so a
    // recycled pid is not signalled.
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

const DEMO = { slug: 'demo', id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }
const KEEPER_ID = '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b'

describe('destroyProjectSubstrate', () => {
  it('removes the project\'s node-local tree and image store on this host, by id', async () => {
    const tree = nodeLocalProjectPath(DEMO.id)
    const store = imageStoreDir(DEMO.id)
    await fsp.mkdir(path.join(tree, '.cached-packages', 'pnpm-store'), { recursive: true })
    await fsp.mkdir(path.join(store, 'gen-1'), { recursive: true })
    await fsp.mkdir(nodeLocalProjectPath(KEEPER_ID), { recursive: true })

    await destroyProjectSubstrate(DEMO)

    await expect(fsp.access(tree)).rejects.toThrow()
    await expect(fsp.access(store)).rejects.toThrow()
    await expect(fsp.access(nodeLocalProjectPath(KEEPER_ID))).resolves.toBeUndefined()
  })
})

describe('reapNodeLocal', () => {
  const STALE = new Date(Date.now() - 3_600_000)
  async function seed(dir: string): Promise<string> {
    await fsp.mkdir(path.join(dir, 'x'), { recursive: true })
    await fsp.utimes(dir, STALE, STALE)
    return dir
  }

  // Keyed on ids, so leftovers from a failed removal are collected, except a
  // tree written since the sweep began.
  it('removes node-local trees no live project id owns', async () => {
    const live = await seed(nodeLocalProjectPath(DEMO.id))
    const liveStore = await seed(imageStoreDir(DEMO.id))
    const removed = await seed(nodeLocalProjectPath(KEEPER_ID))
    const removedStore = await seed(imageStoreDir(KEEPER_ID))
    const unknown = await seed(nodeLocalProjectPath('other'))
    const fresh = nodeLocalProjectPath('staging')
    await fsp.mkdir(fresh, { recursive: true })

    await reapNodeLocal({ projectIds: new Set([DEMO.id]), workspaceIds: new Set([UUID]) })

    for (const dir of [live, liveStore, fresh]) {
      await expect(fsp.access(dir)).resolves.toBeUndefined()
    }
    for (const dir of [removed, removedStore, unknown]) {
      await expect(fsp.access(dir)).rejects.toThrow()
    }
  })

  // Following a symlinked entry or root would delete whatever it points at.
  it('never follows a link, at an entry or at a root', async () => {
    const victims = await fsp.mkdtemp(path.join(os.tmpdir(), 'yaac-reap-victim-'))
    try {
      const entryVictim = await seed(path.join(victims, 'entry-target'))
      const rootVictim = await seed(path.join(victims, 'root-target', 'not-an-id'))
      await fsp.mkdir(path.dirname(nodeLocalProjectPath('x')), { recursive: true })
      await fsp.symlink(entryVictim, nodeLocalProjectPath('linked'))
      await fsp.rm(path.dirname(imageStoreDir('x')), { recursive: true, force: true })
      await fsp.symlink(path.dirname(rootVictim), path.dirname(imageStoreDir('x')))

      await reapNodeLocal({ projectIds: new Set(), workspaceIds: new Set() })

      for (const dir of [entryVictim, rootVictim]) {
        await expect(fsp.access(path.join(dir, 'x'))).resolves.toBeUndefined()
      }
    } finally {
      await fsp.rm(victims, { recursive: true, force: true })
    }
  })
})

describe('detachedTeardownCommand', () => {
  it('quotes every host path it composes into an rm -rf', () => {
    // A space in the data dir or tmpdir ("…/My Drive/yaac") would split
    // an unquoted path into two.
    const cmd = detachedTeardownCommand(TARGET)
    expect(cmd).toMatch(/rm -rf '[^']*'/)
    expect(cmd).toMatch(/tmux -S '[^']*'/)
  })

  // `kill-server` returns once SIGHUPs are sent, not when panes are dead.
  // The caller appends removals of dirs those panes may still write to, so
  // the script first waits (with a bound) for the server to be gone.
  it('waits for the tmux server to be gone between the kill and the removals', () => {
    const cmd = detachedTeardownCommand(TARGET)
    const kill = cmd.indexOf('kill-server')
    const wait = cmd.indexOf('has-session')
    const firstRm = cmd.indexOf('rm -')
    expect(kill).toBeGreaterThanOrEqual(0)
    expect(wait).toBeGreaterThan(kill)
    expect(firstRm).toBeGreaterThan(wait)
    expect(cmd).toMatch(/while \[ "\$i" -lt \d+ \]/)
  })

  it('composes commands that tolerate having already run', () => {
    const cmd = detachedTeardownCommand(TARGET)
    // The script is re-issued on resume and callers append commands to it,
    // so no step may abort it.
    expect(cmd).toContain('kill-server')
    expect(cmd).toContain('|| true')
    expect(cmd).toContain(UUID)
  })

  it('removes the agent socket alongside the tmux one', () => {
    const cmd = detachedTeardownCommand(TARGET)
    expect(cmd).toMatch(/rm -f '[^']*-ssh\.sock'/)
  })

  /**
   * Runs the script against stubbed `ps` and `kill`, rather than matching
   * its text. The detached script finds the agent by its socket path in
   * `ps` output. Since `sh -c` puts the script in its own argv, a naive
   * pipeline would match and kill the teardown shell itself, which no string
   * assertion would catch.
   */
  describe('run against a stubbed ps', () => {
    let binDir: string
    let killLog: string

    beforeEach(() => {
      binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-teardown-bin-'))
      killLog = path.join(binDir, 'killed.txt')
      // One ssh-agent for this workspace, plus a decoy for another.
      const paths = containerlessWorkspacePaths(TARGET.unitName)
      fs.writeFileSync(path.join(binDir, 'ps'), [
        '#!/bin/sh',
        'echo "  4242 ssh-agent -D -a ' + paths.sshAgentSock + '"',
        'echo "  9999 ssh-agent -D -a /tmp/other/xyz-ssh.sock"',
        // Real ps output includes the teardown shell, so a self-match can occur.
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

    /** Run the script with the stubs first on PATH; return what it killed. */
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
      const { killed, marker } = runScript()
      expect(marker).toBe(true)
      expect(killed).not.toContain(String(process.pid))
      // Exactly one pid, so nothing else matched.
      expect(killed).toHaveLength(1)
    })
  })
})
