import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setDataDir } from '@yaac/shared/paths'
import { workspaceDir } from '@yaac/shared/project-paths'
import { agentBinDirs } from '@yaac/shared/tool-install'
import { substrateFixture } from '@yaac/test-utils/fake-driver'
import type { WorkspaceMount, WorkspaceSpec } from '#drivers/contract'

// Only host process calls are mocked, so the launch's mkdirs, symlinks,
// marker and command text are real.
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
import { AGENT_SESSION_VARS, launchWorkspace } from '#drivers/containerless/launch'
import { _resetRegistryForTests, listWorkspaces } from '#drivers/containerless/registry'
import { TOOL_HOME_VARS } from '#drivers/containerless/tool-homes'

const execFileAsync = promisify(execFile)
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
    secretEnvKeys: [],
    mounts: [],
    moduleDirs: [],
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
  // '4242' answers both the tmux pid probe and `ssh-add -L`; the ssh-agent
  // cases override the latter.
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
  fs.mkdirSync(workspaceDir('demo', UUID), { recursive: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('launchWorkspace', () => {
  it('opens the session on the placeholder the stale reaper looks for', async () => {
    await launchWorkspace(spec())
    const newSession = tmuxCalls().find((a) => a.includes('new-session'))
    expect(newSession).toBeDefined()
    // `probeAgentPaneState` reads `sleep infinity` as "no agent yet".
    // Starting the agent here would let a fast-failing tool end the session
    // before setup finished.
    expect(newSession).toContain('sleep infinity')
    expect(newSession).toContain('yaac')
    // The window is named for the tool, the `yaac:<tool>` target later
    // respawns and probes use.
    expect(newSession).toContain('claude')
    // Windows open in the checkout, not the server's cwd.
    expect(newSession).toContain(workspaceDir('demo', UUID))
  })

  it('registers the workspace and writes the marker a restart recovers from', async () => {
    const handle = await launchWorkspace(spec())
    expect(handle.running).toBe(true)
    expect(listWorkspaces()).toHaveLength(1)

    // The marker is the only durable record; a restarted server finds the
    // workspace through it.
    const marker = JSON.parse(await fsp.readFile(
      path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'workspace.json'),
      'utf8',
    )) as { workspaceId: string; tool: string; tmuxPid: number }
    expect(marker.workspaceId).toBe(UUID)
    expect(marker.tool).toBe('claude')
    // Read from tmux, as the root of the port scan's process tree.
    expect(marker.tmuxPid).toBe(4242)
  })

  it('writes the launch\'s own entries to the marker, and never a credential', async () => {
    vi.stubEnv('HOST_SHELL_TOKEN', 'exported-by-the-user')
    await launchWorkspace(spec({
      env: ['PROJECT_SETTING=on', 'ANTHROPIC_API_KEY=sk-real', 'YAAC_MAMA_TOKEN=bearer'],
      secretEnvKeys: ['ANTHROPIC_API_KEY', 'YAAC_MAMA_TOKEN'],
    }))
    const newSession = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    // The session gets every variable...
    expect(newSession.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-real', YAAC_MAMA_TOKEN: 'bearer' })

    // ...but the marker, which a restart reads, holds only what the create
    // added: no secrets and no inherited host environment.
    const raw = await fsp.readFile(
      path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'workspace.json'),
      'utf8',
    )
    const { launchEnv } = JSON.parse(raw) as { launchEnv: Record<string, string> }
    expect(launchEnv.PROJECT_SETTING).toBe('on')
    expect(raw).not.toContain('sk-real')
    expect(raw).not.toContain('bearer')
    expect(raw).not.toContain('exported-by-the-user')
  })

  it('gives the workspace its own HOME with the project tool dirs linked in', async () => {
    const claudeSrc = path.join(dataDir, 'global', 'projects', 'demo', 'claude')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' },
    ]
    await launchWorkspace(spec({ mounts }))

    // A container mount becomes a symlink here, as the driver contract
    // allows.
    const home = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    expect(await fsp.realpath(path.join(home, '.claude')))
      .toBe(await fsp.realpath(claudeSrc))
    // HOME points at the links; otherwise the agent would read the server
    // user's config.
    const newSession = tmuxCalls().find((a) => a.includes('new-session'))
    expect(newSession).toBeDefined()
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.HOME).toBe(home)
  })

  it('relaunches over its own leftovers instead of tripping on them', async () => {
    const claudeSrc = path.join(dataDir, 'global', 'projects', 'demo', 'claude')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' },
    ]
    // A create retries failed launches, so every step must tolerate the
    // previous attempt's state.
    await launchWorkspace(spec({ mounts }))
    await expect(launchWorkspace(spec({ mounts }))).resolves.toBeDefined()
  })

  it('puts the staged helper scripts and the pinned agents where the workspace will find them', async () => {
    // A pod has these in `/usr/local/bin`; here they go in the workspace's
    // own bin dir.
    const staged = path.join(dataDir, 'staged-yaac-mama')
    await fsp.writeFile(staged, '#!/bin/sh\n')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: staged, type: 'File' }, mountPath: '/usr/local/bin/yaac-mama' },
    ]
    await launchWorkspace(spec({ mounts }))
    const home = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    const binDir = path.join(home, '.local', 'bin')
    expect(await fsp.realpath(path.join(binDir, 'yaac-mama'))).toBe(await fsp.realpath(staged))
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    // Then yaac's pinned agents, ahead of the host's (which may be any
    // version).
    const [first, ...rest] = env.env.PATH?.split(path.delimiter) ?? []
    expect(first).toBe(binDir)
    expect(rest.slice(0, agentBinDirs().length)).toEqual(agentBinDirs())
    expect(rest.slice(agentBinDirs().length).join(path.delimiter)).toBe(process.env.PATH)
  })

  it('translates an env value naming a mounted path to that mount\'s source', async () => {
    // Callers write env against the container layout. Here a value resolves
    // to the mount's source (the project's dir), not the private HOME's link
    // to it, since a tool keying on the path string would otherwise get a
    // per-workspace value.
    //
    // Unmounted values are left alone: a yaac dev host's user home really is
    // /home/yaac, so rewriting them would redirect real host paths.
    const piSrc = path.join(dataDir, 'global', 'projects', 'demo', 'pi')
    const claudeSrc = path.join(dataDir, 'global', 'projects', 'demo', 'claude')
    const cachedSrc = path.join(dataDir, 'node-local', 'projects', 'demo', '.cached-packages')
    await fsp.mkdir(path.join(piSrc, 'agent', 'sessions'), { recursive: true })
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: piSrc }, mountPath: '/home/yaac/.pi' },
      { source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' },
      { source: { kind: 'hostPath', path: cachedSrc }, mountPath: '/home/yaac/.cached-packages' },
    ]
    await launchWorkspace(spec({
      mounts,
      env: [
        'PI_CODING_AGENT_DIR=/home/yaac/.pi/agent',
        'PI_CODING_AGENT_SESSION_DIR=/home/yaac/.pi/agent/sessions',
        'CLAUDE_CONFIG_DIR=/home/yaac/.claude',
        'pnpm_config_store_dir=/home/yaac/.cached-packages/pnpm-store',
        'npm_config_store_dir=/home/yaac/.cached-packages/pnpm-store',
        'MY_OWN_PATH=/home/yaac/notes',
      ],
    }))

    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.PI_CODING_AGENT_SESSION_DIR)
      .toBe(path.join(piSrc, 'agent', 'sessions'))
    expect(env.env.PI_CODING_AGENT_DIR).toBe(path.join(piSrc, 'agent'))
    // The project's dir, not the workspace's: claude names its macOS
    // Keychain item after it, and a per-workspace name would let one token
    // refresh break every sibling workspace.
    const home = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    expect(env.env.CLAUDE_CONFIG_DIR).toBe(claudeSrc)
    expect(env.env.CLAUDE_CONFIG_DIR).not.toContain(home)
    // The project's shared pnpm store, on the checkouts' filesystem so
    // node_modules can hardlink into it.
    expect(env.env.pnpm_config_store_dir).toBe(path.join(cachedSrc, 'pnpm-store'))
    expect(env.env.npm_config_store_dir).toBe(path.join(cachedSrc, 'pnpm-store'))
    expect(env.env.MY_OWN_PATH).toBe('/home/yaac/notes')
  })

  it('resolves a value under a nested mount to the innermost source', async () => {
    // Resolving against the outer mount would give the wrong directory.
    const claudeSrc = path.join(dataDir, 'global', 'projects', 'demo', 'claude')
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
    // Skipping silently would fail much later somewhere unrelated.
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: '/opt/sock' }, mountPath: '/var/run/thing.sock' },
    ]
    await expect(launchWorkspace(spec({ mounts })))
      .rejects.toThrow(/no host equivalent for a mount at \/var\/run\/thing\.sock/)
  })

  it('leaves a redirect INTO the checkout alone, so git never sees a link', async () => {
    // Unlike a pod mount, a symlink is visible to git: `git add -A` would
    // commit an absolute host path, and the ephemeral-modules guard would
    // trip on it, making a stopped workspace unrestartable.
    const modules = path.join(dataDir, 'modules-cache')
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: modules }, mountPath: '/workspace/node_modules' },
    ]
    await launchWorkspace(spec({ mounts }))
    await expect(fsp.lstat(path.join(workspaceDir('demo', UUID), 'node_modules')))
      .rejects.toThrow()
  })

  it('skips a mount that would nest inside another rather than writing through it', async () => {
    // Here the tool home is a symlink into shared project state, so writing
    // a builtin skill into it would affect every workspace.
    const claudeSrc = path.join(dataDir, 'global', 'projects', 'demo', 'claude')
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
    // A backslash, `#`, quotes and a newline would all break git config
    // syntax unless escaped.
    const name = 'Ada "The" \\Lovelace #1\n[core]\n\tpager = touch /tmp/x'
    await launchWorkspace(spec({
      env: [`YAAC_GIT_NAME=${name}`, 'YAAC_GIT_EMAIL=ada@example.com'],
    }))
    const home = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    const gitconfigPath = path.join(home, '.gitconfig')
    const read = async (key: string): Promise<string> =>
      (await execFileAsync('git', ['config', '--file', gitconfigPath, '--get', key])).stdout
    expect(await read('user.name')).toBe(`${name}\n`)
    expect(await read('user.email')).toBe('ada@example.com\n')
    await expect(read('core.pager')).rejects.toThrow()
    const gitconfig = await fsp.readFile(gitconfigPath, 'utf8')
    // Both repo roots are trusted, as in a pod.
    expect(gitconfig).toContain(workspaceDir('demo', UUID))

    // GIT_CONFIG_GLOBAL points at that file; an inherited value would
    // otherwise make git ignore it.
    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.GIT_CONFIG_GLOBAL).toBe(path.join(home, '.gitconfig'))
  })

  it('hands the workspace\'s own git the real HTTPS credential', async () => {
    // No proxy injects a token here, and `origin` has none, so the
    // workspace needs a credential helper to fetch or push.
    await launchWorkspace(spec({
      gitCredential: { kind: 'https', host: 'github.com', token: 'ghp_a/b+c%d' },
    }))
    const home = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')

    const gitconfig = await fsp.readFile(path.join(home, '.gitconfig'), 'utf8')
    // An empty helper first resets the list, so a system-wide helper cannot
    // answer with the user's own stored credential.
    expect(gitconfig).toContain('helper =\n')
    expect(gitconfig).toContain('helper = store')

    // Percent-encoded, since git URL-decodes the stored credential.
    const creds = path.join(home, '.git-credentials')
    expect(await fsp.readFile(creds, 'utf8'))
      .toBe('https://x-access-token:ghp_a%2Fb%2Bc%25d@github.com\n')
    expect((await fsp.stat(creds)).mode & 0o777).toBe(0o600)
  })

  it('holds an SSH key in a per-workspace agent, never in the workspace', async () => {
    // With no proxy, the workspace gets its own ssh-agent. The key is piped
    // in over stdin, so no private key is left on disk; the home holds only
    // the public key.
    const knownHosts = path.join(dataDir, 'global', 'projects', 'demo', 'known_hosts')
    await launchWorkspace(spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
      ssh: { knownHostsFile: knownHosts },
    }))

    // Piped in, never written to disk.
    expect(mockRunHostWithInput).toHaveBeenCalledWith(
      ['ssh-add', '-'], PRIVATE_KEY, expect.anything(),
    )
    const home = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    const pub = path.join(home, '.ssh', 'id.pub')
    expect(await fsp.readFile(pub, 'utf8')).toBe('ssh-ed25519 AAAAPUBLIC yaac\n')

    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.SSH_AUTH_SOCK).toContain('-ssh.sock')
    // Cleared when the session is created, before any attach; otherwise
    // each attach would copy the host user's SSH_AUTH_SOCK into the session.
    const newSession = tmuxCalls().find((a) => a.includes('new-session')) ?? []
    expect(newSession.slice(-5)).toEqual([';', 'set-option', '-g', 'update-environment', ''])
    const sshCmd = env.env.GIT_SSH_COMMAND ?? ''
    // `-i` with the public key and IdentitiesOnly pins ssh to the agent's
    // identity.
    expect(sshCmd).toContain(`-i ${pub}`)
    expect(sshCmd).toContain('IdentitiesOnly=yes')
    // Host key verification is as strict as in a pod.
    expect(sshCmd).toContain(`UserKnownHostsFile=${knownHosts}`)
    expect(sshCmd).toContain('StrictHostKeyChecking=yes')

    // No file under the home holds the private key.
    for (const entry of await fsp.readdir(home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const body = await fsp.readFile(path.join(entry.parentPath, entry.name), 'utf8')
      expect(body).not.toContain('PRIVATE KEY')
    }
  })

  it('ends the agent a previous life left running before binding a new one', async () => {
    // On relaunch (a retried create or restart), unlinking the socket alone
    // would leave the old agent running with the key.
    const sshSpec = (): WorkspaceSpec => spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
      ssh: { knownHostsFile: path.join(dataDir, 'global', 'projects', 'demo', 'known_hosts') },
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
      ssh: { knownHostsFile: path.join(dataDir, 'global', 'projects', 'demo', 'known_hosts') },
    }))

    const marker = JSON.parse(await fsp.readFile(path.join(
      dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'workspace.json',
    ), 'utf8')) as { sshAgentPid?: number }
    expect(marker.sshAgentPid).toBe(4242)
  })

  it('refuses an SSH credential with no host list rather than skipping the check', async () => {
    // Otherwise the workspace would verify no host key at all.
    await expect(launchWorkspace(spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
    }))).rejects.toThrow(/known_hosts/)
  })

  it('clears a credential the last launch left behind', async () => {
    // A relaunch may bring a rotated token, a switch to SSH, or no
    // credential at all.
    const home = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
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
    // Agents run as this user, so passing the server's config would let a
    // workspace reconfigure its server.
    expect(Object.keys(call.env).filter((k) => k.startsWith('YAAC_')))
      .toEqual(expect.arrayContaining(['YAAC_GIT_NAME']))
    expect(call.env.YAAC_DATA_DIR).toBeUndefined()
    expect(call.env.YAAC_SERVER_PORT).toBeUndefined()
  })

  it('drops the host variables that would re-point a tool away from its home', async () => {
    // Tool homes are staged relative to HOME, which only works if the tools
    // use their defaults. An inherited override would point the agent at
    // the server user's config and credentials.
    const claudeSrc = path.join(dataDir, 'global', 'projects', 'demo', 'claude')
    const hostConfig = path.join(dataDir, 'the-host-user')
    const saved = { ...process.env }
    // Set every name from the list itself, so new entries are covered.
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

    // Dropping a user's variable is otherwise invisible, so the create says
    // so.
    const notice = progress.find((m) => m.includes('CLAUDE_CONFIG_DIR'))
    expect(notice, 'the create never said it was ignoring anything').toBeDefined()
    expect(notice).toContain('CODEX_HOME')

    const call = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    for (const key of TOOL_HOME_VARS) {
      expect(call.env[key], `${key} reached the workspace`).toBeUndefined()
    }
    // Dropped rather than pinned, so the tools use their defaults, which the
    // staged home provides.
    const home = path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'home')
    expect(call.env.HOME).toBe(home)
    expect(await fsp.realpath(path.join(home, '.claude'))).toBe(await fsp.realpath(claudeSrc))
  })

  it('drops the markers of the agent session that started the server', async () => {
    // A server started from a claude session inherits its markers, and a
    // claude with CLAUDE_CODE_CHILD_SESSION stops saving its transcript.
    const saved = { ...process.env }
    for (const key of AGENT_SESSION_VARS) process.env[key] = '1'
    process.env.GIT_EDITOR = 'true'
    try {
      await launchWorkspace(spec())
    } finally {
      process.env = saved
    }
    const call = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    for (const key of AGENT_SESSION_VARS) {
      expect(call.env[key], `${key} reached the workspace`).toBeUndefined()
    }
    // The session's no-op editor is dropped too, or `git commit` in a
    // terminal aborts on an empty message.
    expect(call.env.GIT_EDITOR).toBeUndefined()
  })

  it('lets a caller\'s own env win over the inherited host value', async () => {
    // The deny lists only filter inherited values. A value the create put on
    // the spec (envPassthrough, config.env) is kept.
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
    // The host's value is still not what the workspace sees, so the notice
    // names it.
    expect(progress.some((m) => m.startsWith('Ignoring') && m.includes('XDG_CONFIG_HOME'))).toBe(true)
  })

  it('survives a tmux that refuses its cosmetic options', async () => {
    // These options are cosmetic, so a refusal must not fail the create.
    // (`update-environment` is set in the new-session call and is not refused
    // here.)
    mockRunHost.mockImplementation((argv: string[]) =>
      argv.includes('set-option') && !argv.includes('new-session')
        ? Promise.reject(new Error('unknown option'))
        : Promise.resolve({ stdout: '7', stderr: '' }))
    await expect(launchWorkspace(spec())).resolves.toBeDefined()
  })
})
