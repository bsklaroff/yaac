import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { setDataDir } from '@yaac/shared/paths'
import { worktreeDir } from '@yaac/shared/project-paths'
import { substrateFixture } from '@yaac/test-utils/fake-driver'
import type { WorkspaceMount, WorkspaceSpec } from '#drivers/contract'

// Mocked at the process boundary — this driver's whole substrate is
// `child_process`, so with it stubbed the launch runs for real: the real
// mkdirs, the real symlinks, the real marker, and the real command text.
import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
const mockOnPath = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
  onPath: mockOnPath,
}))
import { launchWorkspace } from '#drivers/containerless/launch'
import { _resetRegistryForTests, listWorkspaces } from '#drivers/containerless/registry'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
let dataDir: string

/** Every tmux invocation the launch made, as flat argv arrays. */
const tmuxCalls = (): string[][] =>
  mockRunHost.mock.calls.map((c) => c[0] as string[]).filter((a) => a[0] === 'tmux')

function spec(overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    projectSlug: 'demo',
    workspaceId: UUID,
    tool: 'claude',
    mode: 'tui',
    prewarm: false,
    env: ['YAAC_GIT_NAME=Ada', 'YAAC_GIT_EMAIL=ada@example.com', 'YAAC_STATUS_RIGHT= demo 4bfc59c6 '],
    mounts: [],
    resources: {
      memoryRequestBytes: 1, memoryLimitBytes: 1, cpuRequestMillis: 1,
      cpuLimitMillis: 1, ephemeralStorageRequestBytes: 1, ephemeralStorageLimitBytes: 1,
    },
    postStartExec: [],
    nestedContainers: false,
    substrate: substrateFixture(),
    ...overrides,
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-launch-'))
  setDataDir(dataDir)
  _resetRegistryForTests()
  mockRunHost.mockReset()
  mockRunHost.mockResolvedValue({ stdout: '4242', stderr: '' })
  mockOnPath.mockReset()
  mockOnPath.mockResolvedValue(true)
  fs.mkdirSync(worktreeDir('demo', UUID), { recursive: true })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('launchWorkspace', () => {
  it('opens the session on the placeholder the stale reaper looks for', async () => {
    await launchWorkspace(spec())
    const newSession = tmuxCalls().find((a) => a.includes('new-session'))
    expect(newSession).toBeDefined()
    // `sleep infinity` is what `probeAgentPaneState` reads as "started but
    // no agent yet"; starting the agent here instead would let a
    // fast-failing tool end the session before setup finished.
    expect(newSession).toContain('sleep infinity')
    expect(newSession).toContain('yaac')
    // The window carries the tool name, which is the `yaac:<tool>` target
    // every later respawn and probe addresses.
    expect(newSession).toContain('claude')
    // Windows open in the checkout, not wherever the server happens to be.
    expect(newSession).toContain(worktreeDir('demo', UUID))
  })

  it('registers the workspace and writes the marker a restart recovers from', async () => {
    const handle = await launchWorkspace(spec())
    expect(handle.running).toBe(true)
    expect(listWorkspaces()).toHaveLength(1)

    // The marker is the substrate's only durable record: without it a
    // restarted server cannot know the worktree exists at all.
    const marker = JSON.parse(await fsp.readFile(
      path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'workspace.json'),
      'utf8',
    )) as { worktreeId: string; tool: string; tmuxPid: number }
    expect(marker.worktreeId).toBe(UUID)
    expect(marker.tool).toBe('claude')
    // Read back from tmux so the port scan has a tree root to walk.
    expect(marker.tmuxPid).toBe(4242)
  })

  it('gives the workspace its own HOME with the project tool dirs linked in', async () => {
    const claudeSrc = path.join(dataDir, 'projects', 'demo', 'claude')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' },
    ]
    await launchWorkspace(spec({ mounts }))

    // A container's mount becomes a symlink here — the contract's own note
    // that "a host-process driver reads a hostPath as a bind or a symlink".
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    expect(await fsp.realpath(path.join(home, '.claude')))
      .toBe(await fsp.realpath(claudeSrc))
    // HOME is what makes the links reachable; without it the agent would
    // read the SERVER user's config instead of the worktree's.
    const newSession = tmuxCalls().find((a) => a.includes('new-session'))
    expect(newSession).toBeDefined()
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.HOME).toBe(home)
  })

  it('relaunches over its own leftovers instead of tripping on them', async () => {
    const claudeSrc = path.join(dataDir, 'projects', 'demo', 'claude')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' },
    ]
    // A create retries its launch after a failed attempt, so every step has
    // to tolerate the last attempt's state.
    await launchWorkspace(spec({ mounts }))
    await expect(launchWorkspace(spec({ mounts }))).resolves.toBeDefined()
  })

  it('puts the staged helper scripts somewhere the workspace will find them', async () => {
    // A pod gets these from `/usr/local/bin` already being on PATH; there is
    // no writable system bin here, so they go in the workspace's own.
    const staged = path.join(dataDir, 'staged-yaac-spawn')
    await fsp.writeFile(staged, '#!/bin/sh\n')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: staged, type: 'File' }, mountPath: '/usr/local/bin/yaac-spawn' },
    ]
    await launchWorkspace(spec({ mounts }))
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    const binDir = path.join(home, '.local', 'bin')
    expect(await fsp.realpath(path.join(binDir, 'yaac-spawn'))).toBe(await fsp.realpath(staged))
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.PATH?.startsWith(binDir)).toBe(true)
  })

  it('follows an env value naming a mounted path to where the mount landed', async () => {
    // The caller writes env against the container layout, because that is the
    // filesystem every driver was written against — pi is pointed at its
    // session dir inside its mounted home. Left alone, it would write its
    // transcripts to a path that does not exist here and the herd would find
    // none. A value under a mount this spec declared follows that mount.
    //
    // The user's own values do NOT: a yaac dev host runs as a user whose home
    // is literally /home/yaac, so rewriting anything container-shaped would
    // silently redirect a real host path they passed in.
    const piSrc = path.join(dataDir, 'projects', 'demo', 'pi')
    await fsp.mkdir(path.join(piSrc, 'agent', 'sessions'), { recursive: true })
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: piSrc }, mountPath: '/home/yaac/.pi' },
    ]
    await launchWorkspace(spec({
      mounts,
      env: [
        'PI_CODING_AGENT_SESSION_DIR=/home/yaac/.pi/agent/sessions',
        'MY_OWN_PATH=/home/yaac/notes',
      ],
    }))

    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.PI_CODING_AGENT_SESSION_DIR)
      .toBe(path.join(home, '.pi', 'agent', 'sessions'))
    // Which resolves, through the mount's own link, to the shared project dir
    // the server reads transcripts back out of.
    expect(await fsp.realpath(env.env.PI_CODING_AGENT_SESSION_DIR ?? ''))
      .toBe(await fsp.realpath(path.join(piSrc, 'agent', 'sessions')))
    expect(env.env.MY_OWN_PATH).toBe('/home/yaac/notes')
  })

  it('refuses a mount it has no host equivalent for rather than dropping it', async () => {
    // Silently skipping would hand back a worktree missing the thing its
    // config asked for, failing much later and somewhere unrelated.
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: '/opt/sock' }, mountPath: '/var/run/thing.sock' },
    ]
    await expect(launchWorkspace(spec({ mounts })))
      .rejects.toThrow(/no host equivalent for a mount at \/var\/run\/thing\.sock/)
  })

  it('leaves a redirect INTO the checkout alone, so git never sees a link', async () => {
    // A pod mounts node_modules onto other storage and git never sees it. A
    // symlink is not a mount: git reports it untracked (so `git add -A`
    // commits an absolute host path), and the ephemeral-modules guard trips
    // on the driver's own link, which made a stopped worktree unrestartable.
    const modules = path.join(dataDir, 'modules-cache')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: modules }, mountPath: '/workspace/node_modules' },
    ]
    await launchWorkspace(spec({ mounts }))
    await expect(fsp.lstat(path.join(worktreeDir('demo', UUID), 'node_modules')))
      .rejects.toThrow()
  })

  it('skips a mount that would nest inside another rather than writing through it', async () => {
    // A pod layers a builtin skill over a mounted tool home; here the tool
    // home is a symlink into shared project state, so writing the skill
    // would leave one worktree's staging where every worktree reads.
    const claudeSrc = path.join(dataDir, 'projects', 'demo', 'claude')
    const skillSrc = path.join(dataDir, 'staged-skill')
    await fsp.mkdir(skillSrc, { recursive: true })
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' },
      { source: { kind: 'hostPath', path: skillSrc }, mountPath: '/home/yaac/.claude/skills/demo' },
    ]
    await launchWorkspace(spec({ mounts }))
    await expect(fsp.lstat(path.join(claudeSrc, 'skills', 'demo'))).rejects.toThrow()
  })

  it('writes git identity into the workspace home, never the server user\'s', async () => {
    await launchWorkspace(spec())
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    const gitconfig = await fsp.readFile(path.join(home, '.gitconfig'), 'utf8')
    expect(gitconfig).toContain('name = Ada')
    expect(gitconfig).toContain('ada@example.com')
    // Both repo roots are trusted, exactly as the pod's init hook does.
    expect(gitconfig).toContain(worktreeDir('demo', UUID))
  })

  it('keeps the server\'s own wiring out of the workspace environment', async () => {
    await launchWorkspace(spec())
    const call = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    // The agents run as this user; handing them the server's configuration
    // invites a worktree to reconfigure the server that launched it.
    expect(Object.keys(call.env).filter((k) => k.startsWith('YAAC_')))
      .toEqual(expect.arrayContaining(['YAAC_GIT_NAME']))
    expect(call.env.YAAC_DATA_DIR).toBeUndefined()
    expect(call.env.YAAC_SERVER_PORT).toBeUndefined()
  })

  it('survives a tmux that refuses its cosmetic options', async () => {
    // Every option is a display or input preference; a worktree whose bells
    // do not ring beats a create that failed after the session came up.
    mockRunHost.mockImplementation((argv: string[]) =>
      argv.includes('set-option')
        ? Promise.reject(new Error('unknown option'))
        : Promise.resolve({ stdout: '7', stderr: '' }))
    await expect(launchWorkspace(spec())).resolves.toBeDefined()
  })
})
