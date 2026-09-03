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
const mockRunHostWithInput = vi.hoisted(() => vi.fn())
const mockOnPath = vi.hoisted(() => vi.fn())
const mockSpawnSshAgent = vi.hoisted(() => vi.fn())
const mockKillPids = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
  runHostWithInput: mockRunHostWithInput,
  onPath: mockOnPath,
  spawnSshAgent: mockSpawnSshAgent,
  killPids: mockKillPids,
}))
import { launchWorkspace } from '#drivers/containerless/launch'
import { _resetRegistryForTests, listWorkspaces } from '#drivers/containerless/registry'
import { TOOL_HOME_VARS } from '#drivers/containerless/tool-homes'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'
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
  // '4242' answers both the tmux server pid probe and `ssh-add -L`; the
  // agent case overrides the latter where the public key matters.
  mockRunHost.mockResolvedValue({ stdout: '4242', stderr: '' })
  mockRunHost.mockImplementation((argv: string[]) =>
    argv[0] === 'ssh-add' && argv[1] === '-L'
      ? Promise.resolve({ stdout: 'ssh-ed25519 AAAAPUBLIC yaac\n', stderr: '' })
      : Promise.resolve({ stdout: '4242', stderr: '' }))
  mockRunHostWithInput.mockReset()
  mockRunHostWithInput.mockResolvedValue({ stdout: '', stderr: '' })
  mockSpawnSshAgent.mockReset()
  mockSpawnSshAgent.mockResolvedValue(4242)
  mockKillPids.mockReset()
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
    // A `sleep` is what `probeAgentPaneState` reads as "started but no agent
    // yet"; starting the agent here instead would let a fast-failing tool end
    // the session before setup finished. Counting rather than `infinity`,
    // which is a GNU extension the BSD `sleep` on a macOS host rejects — the
    // placeholder would exit instantly and take the session with it.
    expect(newSession).toContain('sleep 2147483647')
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
    const staged = path.join(dataDir, 'staged-yaac-mama')
    await fsp.writeFile(staged, '#!/bin/sh\n')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: staged, type: 'File' }, mountPath: '/usr/local/bin/yaac-mama' },
    ]
    await launchWorkspace(spec({ mounts }))
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    const binDir = path.join(home, '.local', 'bin')
    expect(await fsp.realpath(path.join(binDir, 'yaac-mama'))).toBe(await fsp.realpath(staged))
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.PATH?.startsWith(binDir)).toBe(true)
  })

  it('translates an env value naming a mounted path to that mount\'s source', async () => {
    // The caller writes env against the container layout on both substrates,
    // because that is the filesystem every driver was written against. Here
    // the value resolves to the directory the mount came from — the project's
    // own — rather than to the private HOME's link to it. Both name the same
    // files; a tool that keys anything on the string it was handed can tell
    // them apart, and would get a per-worktree home from the link.
    //
    // The user's own values do NOT move: a yaac dev host runs as a user whose
    // home is literally /home/yaac, so rewriting anything container-shaped
    // would silently redirect a real host path they passed in.
    const piSrc = path.join(dataDir, 'projects', 'demo', 'pi')
    const claudeSrc = path.join(dataDir, 'projects', 'demo', 'claude')
    await fsp.mkdir(path.join(piSrc, 'agent', 'sessions'), { recursive: true })
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: piSrc }, mountPath: '/home/yaac/.pi' },
      { source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' },
    ]
    await launchWorkspace(spec({
      mounts,
      env: [
        'PI_CODING_AGENT_DIR=/home/yaac/.pi/agent',
        'PI_CODING_AGENT_SESSION_DIR=/home/yaac/.pi/agent/sessions',
        'CLAUDE_CONFIG_DIR=/home/yaac/.claude',
        'MY_OWN_PATH=/home/yaac/notes',
      ],
    }))

    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.PI_CODING_AGENT_SESSION_DIR)
      .toBe(path.join(piSrc, 'agent', 'sessions'))
    // A tool's two variables describing one home stay consistent with each
    // other, because one rule produced both.
    expect(env.env.PI_CODING_AGENT_DIR).toBe(path.join(piSrc, 'agent'))
    // The project's dir, not this worktree's: claude names its macOS Keychain
    // item after this string, and a per-worktree one would let the first
    // token refresh take the credential away from every sibling worktree.
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    expect(env.env.CLAUDE_CONFIG_DIR).toBe(claudeSrc)
    expect(env.env.CLAUDE_CONFIG_DIR).not.toContain(home)
    expect(env.env.MY_OWN_PATH).toBe('/home/yaac/notes')
  })

  it('resolves a value under a nested mount to the innermost source', async () => {
    // Otherwise a path inside the inner mount would be expressed against the
    // outer one's source, which is a different directory on this filesystem.
    const claudeSrc = path.join(dataDir, 'projects', 'demo', 'claude')
    const skillSrc = path.join(dataDir, 'staged-skill')
    await fsp.mkdir(skillSrc, { recursive: true })
    await launchWorkspace(spec({
      mounts: [
        { source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' },
        { source: { kind: 'hostPath', path: skillSrc }, mountPath: '/home/yaac/.claude/skills/demo' },
      ],
      env: ['SKILL=/home/yaac/.claude/skills/demo/SKILL.md'],
    }))
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.SKILL).toBe(path.join(skillSrc, 'SKILL.md'))
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

    // And git is pointed AT that file: the workspace inherits the server's
    // environment, so a server started with GIT_CONFIG_GLOBAL set would
    // otherwise have every setting here silently ignored.
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.GIT_CONFIG_GLOBAL).toBe(path.join(home, '.gitconfig'))
  })

  it('hands the workspace\'s own git the real HTTPS credential', async () => {
    // There is no proxy here to inject one in flight, and the checkout's
    // `origin` is deliberately tokenless — so a workspace given nothing
    // cannot fetch or push at all.
    await launchWorkspace(spec({
      gitCredential: { kind: 'https', host: 'github.com', token: 'ghp_a/b+c%d' },
    }))
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')

    const gitconfig = await fsp.readFile(path.join(home, '.gitconfig'), 'utf8')
    // The empty helper first: git takes the FIRST helper that answers, so a
    // host with a system-wide one would otherwise answer with the user's own
    // stored credential for that host rather than the one yaac resolved.
    expect(gitconfig).toContain('helper =\n')
    expect(gitconfig).toContain('helper = store')

    // Percent-encoded, because git url-decodes both halves on the way back
    // in and a token is opaque bytes that may hold a reserved character.
    const creds = path.join(home, '.git-credentials')
    expect(await fsp.readFile(creds, 'utf8'))
      .toBe('https://x-access-token:ghp_a%2Fb%2Bc%25d@github.com\n')
    expect((await fsp.stat(creds)).mode & 0o777).toBe(0o600)
  })

  it('holds an SSH key in a per-worktree agent, never in the workspace', async () => {
    // A pod gets its identity from the proxy's forwarded ssh-agent. There is
    // no proxy here, so the workspace gets an agent of its own — and the key
    // reaches it over stdin, so a stopped worktree (or one whose host
    // rebooted before anyone pressed stop) leaves no usable private key on
    // disk. What lands in the home is the public half.
    const knownHosts = path.join(dataDir, 'projects', 'demo', 'known_hosts')
    await launchWorkspace(spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
      ssh: { knownHostsFile: knownHosts },
    }))

    // Piped in, never written: this is the whole point of the agent.
    expect(mockRunHostWithInput).toHaveBeenCalledWith(
      ['ssh-add', '-'], PRIVATE_KEY, expect.anything(),
    )
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    const pub = path.join(home, '.ssh', 'id.pub')
    expect(await fsp.readFile(pub, 'utf8')).toBe('ssh-ed25519 AAAAPUBLIC yaac\n')

    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.SSH_AUTH_SOCK).toContain('-ssh.sock')
    const sshCmd = env.env.GIT_SSH_COMMAND ?? ''
    // `-i` on the PUBLIC key under IdentitiesOnly is how ssh is pinned to
    // this agent identity without the private half ever being on disk.
    expect(sshCmd).toContain(`-i ${pub}`)
    expect(sshCmd).toContain('IdentitiesOnly=yes')
    // Host verification is not weakened by having no sandbox: an unknown key
    // fails here exactly as it does in a pod.
    expect(sshCmd).toContain(`UserKnownHostsFile=${knownHosts}`)
    expect(sshCmd).toContain('StrictHostKeyChecking=yes')

    // Nothing under the workspace's home holds the private key — not the
    // credential store, and not a stray copy of the key itself.
    for (const entry of await fsp.readdir(home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const body = await fsp.readFile(path.join(entry.parentPath, entry.name), 'utf8')
      expect(body).not.toContain('PRIVATE KEY')
    }
  })

  it('ends the agent a previous life left running before binding a new one', async () => {
    // Unlinking the socket alone would leave that agent running and
    // unreachable, still holding the key — the one thing the arrangement
    // exists to prevent. A relaunch is ordinary: a retried create, a restart.
    const sshSpec = (): WorkspaceSpec => spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
      ssh: { knownHostsFile: path.join(dataDir, 'projects', 'demo', 'known_hosts') },
    })
    await launchWorkspace(sshSpec())
    mockSpawnSshAgent.mockResolvedValue(4343)
    mockKillPids.mockClear()

    await launchWorkspace(sshSpec())

    expect(mockKillPids).toHaveBeenCalledWith([4242], 'SIGTERM')
  })

  it('records the agent pid so teardown can end the process holding the key', async () => {
    await launchWorkspace(spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
      ssh: { knownHostsFile: path.join(dataDir, 'projects', 'demo', 'known_hosts') },
    }))

    const marker = JSON.parse(await fsp.readFile(path.join(
      dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'workspace.json',
    ), 'utf8')) as { sshAgentPid?: number }
    expect(marker.sshAgentPid).toBe(4242)
  })

  it('refuses an SSH credential with no host list rather than skipping the check', async () => {
    // The degraded worktree would be one that verifies no host key at all.
    await expect(launchWorkspace(spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
    }))).rejects.toThrow(/known_hosts/)
  })

  it('clears a credential the last launch left behind', async () => {
    // A relaunch is not always for the same answer: a rotated token, a remote
    // moved to SSH, or a worktree restarted with no credential at all.
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    await launchWorkspace(spec({
      gitCredential: { kind: 'https', host: 'github.com', token: 'first' },
    }))
    await launchWorkspace(spec({
      gitCredential: { kind: 'https', host: 'github.com', token: 'second' },
    }))
    expect(await fsp.readFile(path.join(home, '.git-credentials'), 'utf8')).toContain('second')

    await launchWorkspace(spec())
    await expect(fsp.stat(path.join(home, '.git-credentials'))).rejects.toThrow()
    expect(await fsp.readFile(path.join(home, '.gitconfig'), 'utf8')).not.toContain('helper')
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

  it('drops the host variables that would re-point a tool away from its home', async () => {
    // Every tool home is staged HOME-relative, so the private HOME only
    // decides anything if the tools resolve their defaults. One of these
    // inherited and the agent reads the SERVER user's config — with real
    // credentials in it — and writes its sessions where nothing looks.
    const claudeSrc = path.join(dataDir, 'projects', 'demo', 'claude')
    const hostConfig = path.join(dataDir, 'the-host-user')
    const saved = { ...process.env }
    // Every name the driver clears, poisoned from the list itself — a case
    // that restated the names would keep passing when one was added.
    for (const key of TOOL_HOME_VARS) process.env[key] = path.join(hostConfig, key)
    const progress: string[] = []
    try {
      await launchWorkspace(spec({
        mounts: [{ source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' }],
        onProgress: (m) => progress.push(m),
      }))
    } finally {
      process.env = saved
    }

    // Ignoring a user's environment is otherwise indistinguishable from
    // honoring it — the agent reads the project's config either way, and
    // only the user knows they had pointed it somewhere else.
    const notice = progress.find((m) => m.includes('CLAUDE_CONFIG_DIR'))
    expect(notice, 'the create never said it was ignoring anything').toBeDefined()
    expect(notice).toContain('CODEX_HOME')

    const call = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    for (const key of TOOL_HOME_VARS) {
      expect(call.env[key], `${key} reached the workspace`).toBeUndefined()
    }
    // Dropped rather than pinned, so the tools land on their own defaults —
    // which is what the staged home is built out of.
    const home = path.join(dataDir, 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    expect(call.env.HOME).toBe(home)
    expect(await fsp.realpath(path.join(home, '.claude'))).toBe(await fsp.realpath(claudeSrc))
  })

  it('lets a caller\'s own env win over the inherited host value', async () => {
    // The deny lists are about what LEAKS in. A value the create put on the
    // spec is a stated decision (envPassthrough, config.env), and a worktree
    // that ignored it would be honoring the host over its own config.
    const saved = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = path.join(dataDir, 'the-host-user', '.config')
    const progress: string[] = []
    try {
      await launchWorkspace(spec({
        env: ['XDG_CONFIG_HOME=/etc/xdg-they-asked-for'],
        onProgress: (m) => progress.push(m),
      }))
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = saved
    }
    const call = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(call.env.XDG_CONFIG_HOME).toBe('/etc/xdg-they-asked-for')
    // And the create does not claim to have ignored a value it is handing
    // straight to the agent — the notice reports what was actually dropped,
    // not what the host merely happened to set.
    expect(progress.some((m) => m.includes('XDG_CONFIG_HOME'))).toBe(false)
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
