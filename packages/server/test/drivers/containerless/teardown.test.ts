import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import { setDataDir } from '@yaac/shared/paths'
import { nodeLocalProjectPath } from '@yaac/shared/project-paths'
import { WorkspaceExecError } from '#drivers/contract'

import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
const mockKillPids = vi.hoisted(() => vi.fn())
const mockDescendants = vi.hoisted(() => vi.fn())
const mockIsSshAgentFor = vi.hoisted(() => vi.fn())
const mockLivePids = vi.hoisted(() => vi.fn())
const mockCgroupDir = vi.hoisted(() => vi.fn())
const mockCgroupPids = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
  killPids: mockKillPids,
  descendantPids: mockDescendants,
  processTable: () => Promise.resolve(null),
  isSshAgentFor: mockIsSshAgentFor,
  livePids: mockLivePids,
  cgroupDir: mockCgroupDir,
  cgroupPids: mockCgroupPids,
}))
import {
  destroyProjectSubstrate,
  destroyWorkspace,
  detachedTeardownCommand,
  reapNodeLocal,
} from '#drivers/containerless/teardown'
import { containerlessJobName, containerlessWorkspacePaths, workspaceSliceName } from '#drivers/containerless/paths'
import {
  _resetRegistryForTests,
  listWorkspaces,
  observeLiveness,
  rememberWorkspace,
  restoreWorkspace,
} from '#drivers/containerless/registry'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const TARGET = {
  projectId: 'demo',
  workspaceId: UUID,
  unitName: containerlessJobName('demo', UUID),
}
let dataDir: string

const USER_CGROUP = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service'

/** Whether this host gives a process a systemd slice with a cgroup to read,
 *  as a launch needs for the sweep. */
const CAN_SLICE = fs.existsSync('/sys/fs/cgroup/cgroup.controllers')
  && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true']).status === 0

/** The cgroup a launch records for the workspace on a host with a systemd
 *  user session. Read lazily: its name carries the data dir. */
const sliceUnit = (): string => `${workspaceSliceName(UUID)}.slice`
const cgroup = (): string => `${USER_CGROUP}/yaac.slice/${sliceUnit()}`

/** Every pid sent `signal`, in order. */
const signalled = (signal: string): number[] =>
  mockKillPids.mock.calls.filter((c) => c[1] === signal).flatMap((c) => c[0] as number[])

/** Register a workspace with a known tmux pid, as a launch does, plus an
 *  ssh-agent pid for a project with an SSH remote, or its cgroup. */
function registered(extra: { sshAgentPid?: number; cgroup?: string } = {}): void {
  rememberWorkspace({
    projectId: 'demo', workspaceId: UUID,
    createdAtMs: 1_000, launchEnv: {}, tmuxPid: 4242, ...extra,
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
  mockLivePids.mockReset().mockReturnValue([])
  mockDescendants.mockReset()
  mockDescendants.mockReturnValue([4242])
  mockIsSshAgentFor.mockReset()
  mockIsSshAgentFor.mockResolvedValue(true)
  // This server runs in a login session, outside every workspace.
  mockCgroupDir.mockReset().mockReturnValue('/sys/fs/cgroup/user.slice/user-1000.slice/session-3.scope')
  mockCgroupPids.mockReset().mockResolvedValue([])
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

  it('never signals a dead workspace\'s recorded pid, which may have been recycled', async () => {
    // A dead workspace (e.g. after a host reboot) may have a recycled pid
    // naming an unrelated user process, such as their editor.
    registered()
    observeLiveness(UUID, false, { reason: 'agent-exited' })
    mockDescendants.mockReturnValue([4242, 5150])
    await destroyWorkspace(TARGET)
    expect(mockDescendants).not.toHaveBeenCalled()
    expect(mockKillPids.mock.calls.flatMap((c) => c[0] as number[])).toEqual([])
  })

  it('ends what is still running under the tmux server', async () => {
    registered()
    // Killing tmux does not reach a dev server that left its process group,
    // and it would hold its port forever.
    mockDescendants.mockReturnValue([4242, 5150, 5151])
    await destroyWorkspace(TARGET)
    // Not the tmux server's own pid: by now it has exited, and the number
    // could only be another process's.
    expect(signalled('SIGTERM')).toEqual([5150, 5151])
    expect(signalled('SIGKILL')).toEqual([])
  })

  // What a pane started and then detached from (a daemon, a tmux server of
  // its own, a yaac server and its workspaces) is no descendant of tmux by
  // the time of the stop, and is found only by the cgroup it stayed in.
  it('ends everything in the workspace\'s cgroup, detached or not, and waits for it to empty', async () => {
    registered({ cgroup: cgroup() })
    mockCgroupPids.mockResolvedValueOnce([4242, 6001, 6002]).mockResolvedValueOnce([6002, 6003]).mockResolvedValue([])
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)
    expect(mockCgroupPids).toHaveBeenCalledWith(cgroup())
    expect(mockCgroupPids).toHaveBeenCalledTimes(3)
    // Each once, including one that appeared after the first signal, and
    // none killed: they exited inside the grace. A tmux server the cgroup
    // still lists is one that did not exit, so it is signalled too.
    expect(signalled('SIGTERM')).toEqual([4242, 6001, 6002, 6003])
    expect(signalled('SIGKILL')).toEqual([])
    // The emptied slice would otherwise stay loaded in systemd.
    expect(mockRunHost).toHaveBeenCalledWith(['systemctl', '--user', 'stop', sliceUnit()], expect.anything())

    // The cgroup names the workspace, so unlike a recorded pid it is good
    // for one whose tmux server died before this server saw it.
    mockKillPids.mockClear()
    restoreWorkspace({
      projectId: 'demo', workspaceId: UUID, createdAtMs: 1_000, launchEnv: {}, tmuxPid: 4242, cgroup: cgroup(),
    }, false, { reason: 'agent-exited' })
    mockCgroupPids.mockResolvedValueOnce([6004]).mockResolvedValue([])
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)
    expect(signalled('SIGTERM')).toEqual([6004])
  })

  it('kills what ignores SIGTERM for the whole grace, and says so when even that leaves it running', async () => {
    registered({ cgroup: cgroup() })
    mockDescendants.mockReturnValue([4242, 5150])
    mockLivePids.mockReturnValue([5150])
    mockCgroupPids.mockResolvedValue([6001])
    vi.useFakeTimers()
    try {
      const verdict = destroyWorkspace(TARGET)
      await vi.advanceTimersByTimeAsync(9_000)
      expect(signalled('SIGKILL')).toEqual([])
      await vi.advanceTimersByTimeAsync(7_000)
      await expect(verdict).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
    expect(signalled('SIGTERM')).toEqual([5150, 6001])
    // Only the cgroup's member: a pid from the earlier process table may
    // be another process by now.
    expect(new Set(signalled('SIGKILL'))).toEqual(new Set([6001]))
  })

  it('leaves alone a cgroup that is not this workspace\'s, and one this server may itself be in', async () => {
    const sweeps = async (recorded: string): Promise<boolean> => {
      registered({ cgroup: recorded })
      const inScript = detachedTeardownCommand(TARGET).includes('cgroup.procs')
      mockCgroupPids.mockClear()
      await destroyWorkspace(TARGET)
      expect(mockCgroupPids.mock.calls.length > 0).toBe(inScript)
      return inScript
    }
    expect(await sweeps(cgroup())).toBe(true)
    // A copied data dir's marker names the original install's cgroup.
    expect(await sweeps(`${USER_CGROUP}/yaac.slice/yaac-0a0a0a0a_${UUID.replaceAll('-', '')}.slice`)).toBe(false)
    // The sweep kills whatever a `cgroup.procs` under the dir lists, so the
    // dir must be a cgroup, named plainly.
    expect(await sweeps(`/home/u/${sliceUnit()}`)).toBe(false)
    expect(await sweeps(`/sys/fs/cgroup/../../tmp/${sliceUnit()}`)).toBe(false)

    // A server restarted from one of the workspace's own panes: sweeping
    // the cgroup would end the server and everything it started since.
    mockCgroupDir.mockReturnValue(`${cgroup()}/tmux-spawn-1.scope`)
    expect(await sweeps(cgroup())).toBe(false)
    // A server that cannot tell where it is.
    mockCgroupDir.mockReturnValue(null)
    expect(await sweeps(cgroup())).toBe(false)

    expect(mockRunHost.mock.calls.filter((c) => (c[0] as string[])[0] === 'systemctl')).toHaveLength(1)
  })

  it('waits for every process under tmux to exit, and says so when one outlives the wait', async () => {
    // An agent still exiting writes its last lines into paths the caller is
    // about to delete or move.
    registered()
    mockDescendants.mockReturnValue([4242, 5150])
    mockLivePids.mockReturnValueOnce([5150]).mockReturnValue([])
    await expect(destroyWorkspace(TARGET)).resolves.toBe(true)
    expect(mockLivePids).toHaveBeenCalledTimes(2)

    registered()
    mockLivePids.mockReturnValue([5150])
    vi.useFakeTimers()
    try {
      const verdict = destroyWorkspace(TARGET)
      await vi.advanceTimersByTimeAsync(11_000)
      await expect(verdict).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
      projectId: 'demo', workspaceId: UUID,
      createdAtMs: 1_000, launchEnv: {}, tmuxPid: 4242, sshAgentPid: 777,
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

const DEMO = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const KEEPER_ID = '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b'

describe('destroyProjectSubstrate', () => {
  it('removes the project\'s node-local tree on this host, by id', async () => {
    const tree = nodeLocalProjectPath(DEMO)
    await fsp.mkdir(path.join(tree, '.cached-packages', 'pnpm-store'), { recursive: true })
    await fsp.mkdir(nodeLocalProjectPath(KEEPER_ID), { recursive: true })

    await destroyProjectSubstrate(DEMO)

    await expect(fsp.access(tree)).rejects.toThrow()
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
    const live = await seed(nodeLocalProjectPath(DEMO))
    const removed = await seed(nodeLocalProjectPath(KEEPER_ID))
    const unknown = await seed(nodeLocalProjectPath('other'))
    const fresh = nodeLocalProjectPath('staging')
    await fsp.mkdir(fresh, { recursive: true })

    await reapNodeLocal({ projectIds: new Set([DEMO]), workspaceIds: new Set([UUID]) })

    for (const dir of [live, fresh]) {
      await expect(fsp.access(dir)).resolves.toBeUndefined()
    }
    for (const dir of [removed, unknown]) {
      await expect(fsp.access(dir)).rejects.toThrow()
    }
  })

  // Following a symlinked entry or root would delete whatever it points at.
  it('never follows a link, at an entry or at a root', async () => {
    const victims = await fsp.mkdtemp(path.join(os.tmpdir(), 'yaac-reap-victim-'))
    try {
      const entryVictim = await seed(path.join(victims, 'entry-target'))
      const rootVictim = await seed(path.join(victims, 'root-target', 'not-an-id'))
      const root = path.dirname(nodeLocalProjectPath('x'))
      await fsp.mkdir(root, { recursive: true })
      await fsp.symlink(entryVictim, nodeLocalProjectPath('linked'))
      await reapNodeLocal({ projectIds: new Set(), workspaceIds: new Set() })

      await fsp.rm(root, { recursive: true, force: true })
      await fsp.symlink(path.dirname(rootVictim), root)
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

  // The script is what an ordinary stop runs, so it must reach the same
  // processes as `destroyWorkspace`, and wait for them before the removals.
  it('ends what is left in the workspace\'s cgroup, between the tmux wait and the removals', () => {
    expect(detachedTeardownCommand(TARGET)).not.toContain('cgroup.procs')
    registered({ cgroup: cgroup() })
    const cmd = detachedTeardownCommand(TARGET)
    const sweep = cmd.indexOf(`find '${cgroup()}' -name cgroup.procs`)
    expect(sweep).toBeGreaterThan(cmd.indexOf('has-session'))
    expect(cmd.indexOf(`systemctl --user stop '${sliceUnit()}'`)).toBeGreaterThan(sweep)
    expect(cmd.indexOf('rm -')).toBeGreaterThan(cmd.indexOf('systemctl'))
  })

  /**
   * Run for real, against a slice systemd makes for the test. A process
   * that joins the cgroup after the first signal (one a SIGTERM handler
   * forked, a watcher restarting its child) must still get SIGTERM, not
   * only the SIGKILL at the end of the grace.
   */
  it.skipIf(!CAN_SLICE)('sends SIGTERM once to each process as it appears in the cgroup, and waits for the cgroup to empty', async () => {
    const unit = sliceUnit()
    const inSlice = (...argv: string[]): { pid: number; ended: Promise<NodeJS.Signals | null> } => {
      const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--slice=${unit}`, '--', ...argv], { stdio: 'ignore' })
      return { pid: child.pid ?? 0, ended: new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal))) }
    }
    try {
      // Ignores SIGTERM and ends by itself, so the cgroup is still occupied
      // when the second process joins it.
      const first = inSlice('sh', '-c', 'trap "" TERM; sleep 1.5; true')
      let dir = ''
      await vi.waitFor(() => {
        dir = path.dirname(path.join('/sys/fs/cgroup', fs.readFileSync(`/proc/${String(first.pid)}/cgroup`, 'utf8').trim().slice('0::'.length)))
        expect(path.basename(dir)).toBe(unit)
      }, { timeout: 10_000, interval: 50 })
      // The real one, for this case only: the server is outside the slice.
      mockCgroupDir.mockReturnValue('/sys/fs/cgroup/user.slice')
      registered({ cgroup: dir })

      const state = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless')
      fs.mkdirSync(state, { recursive: true })
      const script = spawn('sh', ['-c', detachedTeardownCommand(TARGET)], { stdio: 'ignore' })
      const done = new Promise((resolve) => script.once('exit', resolve))
      await new Promise((resolve) => setTimeout(resolve, 500))
      const late = inSlice('sleep', '60')

      expect(await late.ended).toBe('SIGTERM')
      expect(await first.ended).toBeNull()
      // The removals wait for the cgroup to empty.
      expect(fs.existsSync(state)).toBe(true)
      await done
      expect(fs.existsSync(state)).toBe(false)
      expect(fs.existsSync(dir)).toBe(false)
    } finally {
      spawnSync('systemctl', ['--user', 'stop', unit])
    }
  }, 30_000)

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
