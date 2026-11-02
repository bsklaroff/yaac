import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setDataDir } from '@yaac/shared/paths'
import { workspaceDir } from '@yaac/shared/project-paths'
import { hostedRemoteUrl } from '@yaac/shared/hosted-git'
import { agentBinDirs } from '@yaac/shared/tool-install'
import { substrateFixture } from '#test/support/fake-driver'
import { hostShellDir } from '#drivers/containerless/paths'
import { KEEPER_STARTING, type WorkspaceMount, type WorkspaceSpec } from '#drivers/contract'

// Only host process calls are mocked, so the launch's mkdirs, symlinks,
// marker and command text are real.
import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
const mockOnPath = vi.hoisted(() => vi.fn())
const mockSpawnSshAgent = vi.hoisted(() => vi.fn())
const mockKillPids = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  runHost: mockRunHost,
  onPath: mockOnPath,
  spawnSshAgent: mockSpawnSshAgent,
  killPids: mockKillPids,
}))
import { AGENT_SESSION_VARS, launchWorkspace } from '#drivers/containerless/launch'
import { _resetRegistryForTests, listWorkspaces } from '#drivers/containerless/registry'
import { _resetPortsForTests, declareWorkspacePorts } from '#drivers/containerless/ports'
import { TOOL_HOME_VARS } from '#drivers/containerless/tool-homes'

const execFileAsync = promisify(execFile)
const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'
let dataDir: string

/** The driver's state dir for the test workspace. */
const stateDir = (): string => path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless')

/** The environment the last launch started tmux with. */
const sessionEnv = (): NodeJS.ProcessEnv => (mockRunHost.mock.calls
  .filter((c) => (c[0] as string[]).includes('new-session')).at(-1)?.[1] as { env: NodeJS.ProcessEnv }).env

/** Every tmux invocation the launch made, as flat argv arrays. */
const tmuxCalls = (): string[][] =>
  mockRunHost.mock.calls.map((c) => c[0] as string[]).filter((a) => a[0] === 'tmux')

function spec(overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    projectId: 'demo',
    workspaceId: UUID,
    prewarm: false,
    env: ['YAAC_GIT_NAME=Ada', 'YAAC_GIT_EMAIL=ada@example.com', 'YAAC_STATUS_RIGHT= demo 4bfc59c6 '],
    secretEnvKeys: [],
    mounts: [],
    scratchDirs: [],
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
  it('opens the session on the keeper, named for its start', async () => {
    await launchWorkspace(spec())
    const newSession = tmuxCalls().find((a) => a.includes('new-session'))
    expect(newSession).toBeDefined()
    // The keeper holds the tmux server open whatever the sessions do, and
    // until the create renames it, `probeSetupState` reads the workspace as
    // still being set up.
    expect(newSession).toContain('sleep 2147483647')
    expect(newSession).toContain('yaac')
    expect(newSession).toContain(KEEPER_STARTING)
    // Windows open in the checkout, not the server's cwd.
    expect(newSession).toContain(workspaceDir('demo', UUID))
  })

  it('registers the workspace and writes the marker a restart recovers from', async () => {
    _resetPortsForTests()
    // Ports are allocated before launch; the marker keeps them.
    const ports = await declareWorkspacePorts(UUID, [{ containerPort: 1, hostPortStart: 1 }])
    const handle = await launchWorkspace(spec())
    expect(handle.running).toBe(true)
    expect(listWorkspaces()).toHaveLength(1)

    // The marker is the only durable record; a restarted server finds the
    // workspace through it.
    const marker = JSON.parse(await fsp.readFile(
      path.join(dataDir, 'global', 'projects', 'demo', 'sessions', UUID, 'containerless', 'workspace.json'),
      'utf8',
    )) as { workspaceId: string; tmuxPid: number; ports: unknown }
    expect(marker.workspaceId).toBe(UUID)
    // Read from tmux, as the root of the port scan's process tree.
    expect(marker.tmuxPid).toBe(4242)
    expect(marker.ports).toEqual(ports)
    _resetPortsForTests()
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

  it('keeps the user\'s own HOME, reaching the tool homes through their variables', async () => {
    const claudeSrc = path.join(dataDir, 'global', 'projects', 'demo', 'claude')
    await launchWorkspace(spec({
      mounts: [{ source: { kind: 'hostPath', path: claudeSrc }, mountPath: '/home/yaac/.claude' }],
      env: ['CLAUDE_CONFIG_DIR=/home/yaac/.claude'],
    }))
    // Nothing isolates a host workspace, so nothing hides the user's setup.
    expect(sessionEnv().HOME).toBe(process.env.HOME)
    expect(sessionEnv().CLAUDE_CONFIG_DIR).toBe(claudeSrc)
    // Created for a first run, but never linked into any home.
    expect(fs.statSync(claudeSrc).isDirectory()).toBe(true)
  })

  it('runs opencode through a wrapper on the project\'s dirs, and the workspace\'s own state', async () => {
    // opencode has no home variable, and setting XDG variables for the whole
    // workspace would hide the user's layout from every other tool.
    const configSrc = path.join(dataDir, 'global', 'projects', 'demo', 'opencode-config')
    const dataSrc = path.join(dataDir, 'global', 'projects', 'demo', 'opencode-data', UUID)
    const mounts: WorkspaceMount[] = [
      { source: { kind: 'hostPath', path: configSrc }, mountPath: '/home/yaac/.config/opencode' },
      { source: { kind: 'hostPath', path: dataSrc }, mountPath: '/home/yaac/.local/share/opencode' },
    ]
    await launchWorkspace(spec({ mounts }))
    // Relaunching replaces what the last launch left.
    await launchWorkspace(spec({ mounts }))

    const home = path.join(stateDir(), 'opencode')
    expect(await fsp.realpath(path.join(home, 'config', 'opencode'))).toBe(await fsp.realpath(configSrc))
    expect(await fsp.realpath(path.join(home, 'data', 'opencode'))).toBe(await fsp.realpath(dataSrc))
    const wrapper = path.join(stateDir(), 'bin', 'opencode')
    expect(sessionEnv().PATH?.split(path.delimiter)).toContain(path.dirname(wrapper))
    const script = await fsp.readFile(wrapper, 'utf8')
    for (const dir of ['config', 'data', 'state', 'cache']) {
      expect(script).toContain(`export XDG_${dir.toUpperCase()}_HOME='${path.join(home, dir)}'`)
    }
    expect(script).toMatch(/exec '[^']*@opencode\+cli@[^']*\/bin\/opencode' "\$@"/)
    expect((await fsp.stat(wrapper)).mode & 0o111).not.toBe(0)
    // The prompt stash script finds opencode's state without the wrapper.
    expect(sessionEnv().YAAC_OPENCODE_STATE).toBe(path.join(home, 'state'))
  })

  it('puts the staged helper scripts and the pinned agents where the workspace will find them', async () => {
    // A pod has these in `/usr/local/bin`; here their staging dir goes on
    // PATH as it is.
    const staged = path.join(dataDir, 'staged')
    const mounts: WorkspaceMount[] = ['yaac-mama', 'yaac-agent-links'].map((name) => (
      { source: { kind: 'hostPath', path: path.join(staged, name), type: 'File' }, mountPath: `/usr/local/bin/${name}` }))
    await launchWorkspace(spec({ mounts }))
    // Then the driver's own (the opencode wrapper), then yaac's pinned
    // agents ahead of the host's (which may be any version).
    const [first, own, ...rest] = sessionEnv().PATH?.split(path.delimiter) ?? []
    expect(first).toBe(staged)
    expect(own).toBe(path.join(stateDir(), 'bin'))
    expect(rest.slice(0, agentBinDirs().length)).toEqual(agentBinDirs())
    expect(rest.slice(agentBinDirs().length).join(path.delimiter)).toBe(process.env.PATH)
  })

  it('translates an env value naming a mounted path to that mount\'s source', async () => {
    // Callers write env against the container layout. Here a value resolves
    // to the mount's source (the project's dir), the same string on every
    // workspace, since a tool may key on it.
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

    const env = sessionEnv()
    expect(env.PI_CODING_AGENT_SESSION_DIR)
      .toBe(path.join(piSrc, 'agent', 'sessions'))
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(piSrc, 'agent'))
    // The project's dir: claude names its macOS Keychain item after it, and
    // a per-workspace name would let one token refresh break every sibling
    // workspace.
    expect(env.CLAUDE_CONFIG_DIR).toBe(claudeSrc)
    // The project's shared pnpm store, on the checkouts' filesystem so
    // node_modules can hardlink into it.
    expect(env.pnpm_config_store_dir).toBe(path.join(cachedSrc, 'pnpm-store'))
    expect(env.npm_config_store_dir).toBe(path.join(cachedSrc, 'pnpm-store'))
    expect(env.MY_OWN_PATH).toBe('/home/yaac/notes')
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

  it('refuses a mount it has no route for rather than dropping it', async () => {
    // Skipping silently would fail much later somewhere unrelated, and a
    // link would write into the user's own home, or show in the checkout
    // as an untracked file `git add -A` would commit.
    for (const mountPath of ['/var/run/thing.sock', '/home/yaac/.cache/thing', '/workspace/node_modules']) {
      await expect(launchWorkspace(spec({
        mounts: [{ source: { kind: 'hostPath', path: path.join(dataDir, 'src') }, mountPath }],
      }))).rejects.toThrow(`no host equivalent for a mount at ${mountPath}`)
    }
    await expect(fsp.lstat(path.join(workspaceDir('demo', UUID), 'node_modules'))).rejects.toThrow()
  })

  it('writes git identity into the workspace\'s own config, never the user\'s', async () => {
    // A backslash, `#`, quotes and a newline would all break git config
    // syntax unless escaped.
    const name = 'Ada "The" \\Lovelace #1\n[core]\n\tpager = touch /tmp/x'
    await launchWorkspace(spec({
      env: [`YAAC_GIT_NAME=${name}`, 'YAAC_GIT_EMAIL=ada@example.com'],
    }))
    const gitconfigPath = path.join(stateDir(), 'gitconfig')
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
    expect(env.env.GIT_CONFIG_GLOBAL).toBe(gitconfigPath)
  })

  it('hands the workspace\'s own git the real HTTPS credential', async () => {
    // No proxy injects a token here, and `origin` has none, so the
    // workspace needs a credential helper to fetch or push.
    await launchWorkspace(spec({
      gitCredential: { kind: 'https', host: 'github.com', token: 'ghp_a/b+c%d' },
    }))
    const gitconfig = await fsp.readFile(path.join(stateDir(), 'gitconfig'), 'utf8')
    // An empty helper first resets the list, so a system-wide helper cannot
    // answer with the user's own stored credential. The store is named, or
    // it would read and write the user's own `~/.git-credentials`.
    const creds = path.join(stateDir(), 'git-credentials')
    expect(gitconfig).toContain('helper =\n')
    expect(gitconfig).toContain(`helper = store --file=${creds}\n`)

    // Percent-encoded, since git URL-decodes the stored credential.
    expect(await fsp.readFile(creds, 'utf8'))
      .toBe('https://x-access-token:ghp_a%2Fb%2Bc%25d@github.com\n')
    expect((await fsp.stat(creds)).mode & 0o777).toBe(0o600)
  })

  it('sends a hosted remote to the server, as the workspace', async () => {
    // The checkout's origin names the remote as a pod sees it; the
    // workspace's gitconfig turns that into the server's loopback origin and
    // sends its yaac-mama token there, and nowhere else.
    await launchWorkspace(spec({
      gitCredential: { kind: 'hosted', origin: 'http://127.0.0.1:9999', token: 'tok' },
    }))
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(stateDir(), 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
    const remote = hostedRemoteUrl('p1')
    expect((await execFileAsync('git', ['ls-remote', '--get-url', remote], { env: gitEnv })).stdout.trim())
      .toBe('http://127.0.0.1:9999/api/workspace/git/p1.git')
    expect((await execFileAsync('git', ['config', '--get-urlmatch', 'http.extraHeader', 'http://127.0.0.1:9999/api/workspace/git/p1.git'], { env: gitEnv })).stdout.trim())
      .toBe('Authorization: Bearer tok')
    await expect(execFileAsync('git', ['config', '--get-urlmatch', 'http.extraHeader', 'http://127.0.0.1:9999/api/workspace/mama'], { env: gitEnv }))
      .rejects.toThrow()
    expect((await fsp.stat(path.join(stateDir(), 'gitconfig'))).mode & 0o777).toBe(0o600)
  })

  it('holds an SSH key in a per-workspace agent, never in the workspace', async () => {
    // With no proxy, the workspace gets its own ssh-agent. The key is piped
    // in over stdin, so no private key is left on disk; the state dir holds
    // only the public key.
    const knownHosts = path.join(dataDir, 'global', 'projects', 'demo', 'known_hosts')
    await launchWorkspace(spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
      ssh: { knownHostsFile: knownHosts },
    }))

    // Piped in, never written to disk.
    expect(mockRunHost).toHaveBeenCalledWith(
      ['ssh-add', '-'], expect.objectContaining({ input: PRIVATE_KEY }),
    )
    const pub = path.join(stateDir(), 'ssh', 'id.pub')
    expect(await fsp.readFile(pub, 'utf8')).toBe('ssh-ed25519 AAAAPUBLIC yaac\n')

    const env = mockRunHost.mock.calls
      .find((c) => (c[0] as string[]).includes('new-session'))?.[1] as { env: NodeJS.ProcessEnv }
    expect(env.env.SSH_AUTH_SOCK).toContain('-ssh.sock')
    // Cleared when the session is created, before any attach; otherwise
    // each attach would copy the host user's SSH_AUTH_SOCK into the session.
    const newSession = tmuxCalls().find((a) => a.includes('new-session')) ?? []
    const created = newSession.indexOf('new-session')
    expect(newSession.slice(created).join(' ')).toMatch(/^new-session [^;]* ; set-option -g update-environment  ;/)
    const sshCmd = env.env.GIT_SSH_COMMAND ?? ''
    // `-i` with the public key and IdentitiesOnly pins ssh to the agent's
    // identity.
    expect(sshCmd).toContain(`-i ${pub}`)
    expect(sshCmd).toContain('IdentitiesOnly=yes')
    // Host key verification is as strict as in a pod.
    expect(sshCmd).toContain(`UserKnownHostsFile=${knownHosts}`)
    expect(sshCmd).toContain('StrictHostKeyChecking=yes')

    // No file the launch wrote holds the private key.
    for (const entry of await fsp.readdir(stateDir(), { recursive: true, withFileTypes: true })) {
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

  it('clears a credential the last launch, or an older yaac\'s private HOME, left behind', async () => {
    // An older yaac kept the credential store in a private HOME.
    await fsp.mkdir(path.join(stateDir(), 'home'), { recursive: true })
    await fsp.writeFile(path.join(stateDir(), 'home', '.git-credentials'), 'https://x:old@github.com\n')
    // A relaunch may bring a rotated token, a switch to SSH, or no
    // credential at all.
    await launchWorkspace(spec({
      gitCredential: { kind: 'https', host: 'github.com', token: 'first' },
    }))
    await launchWorkspace(spec({
      gitCredential: { kind: 'https', host: 'github.com', token: 'second' },
    }))
    expect(await fsp.readFile(path.join(stateDir(), 'git-credentials'), 'utf8')).toContain('second')

    await expect(fsp.stat(path.join(stateDir(), 'home'))).rejects.toThrow()

    await launchWorkspace(spec())
    await expect(fsp.stat(path.join(stateDir(), 'git-credentials'))).rejects.toThrow()
    expect(await fsp.readFile(path.join(stateDir(), 'gitconfig'), 'utf8')).not.toContain('helper')
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
    // An inherited override would point the agent at the user's own config
    // and credentials, and gh at the user's own login.
    const hostConfig = path.join(dataDir, 'the-host-user')
    const saved = { ...process.env }
    // Set every name from the list itself, so new entries are covered.
    for (const key of TOOL_HOME_VARS) process.env[key] = path.join(hostConfig, key)
    process.env.XDG_CONFIG_HOME = path.join(hostConfig, '.config')
    const progress: string[] = []
    try {
      await launchWorkspace(spec({ onProgress: (m) => progress.push(m) }))
    } finally {
      process.env = saved
    }

    // Dropping a user's variable is otherwise invisible, so the create says
    // so.
    const notice = progress.find((m) => m.includes('CLAUDE_CONFIG_DIR'))
    expect(notice, 'the create never said it was ignoring anything').toBeDefined()
    expect(notice).toContain('CODEX_HOME')

    const env = sessionEnv()
    for (const key of TOOL_HOME_VARS) {
      expect(env[key] ?? '', `${key} reached the workspace`).not.toContain(hostConfig)
    }
    // gh gets a config dir of its own, so it never sees the user's login.
    expect(env.GH_CONFIG_DIR).toBe(path.join(stateDir(), 'gh'))
    // The user's XDG layout is theirs to keep; only opencode's wrapper
    // overrides it.
    expect(env.XDG_CONFIG_HOME).toBe(path.join(hostConfig, '.config'))
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
    vi.stubEnv('OPENCODE_CONFIG_DIR', path.join(dataDir, 'the-host-user', 'opencode'))
    const progress: string[] = []
    await launchWorkspace(spec({
      env: ['OPENCODE_CONFIG_DIR=/etc/opencode-they-asked-for'],
      onProgress: (m) => progress.push(m),
    }))
    expect(sessionEnv().OPENCODE_CONFIG_DIR).toBe('/etc/opencode-they-asked-for')
    // The host's value is still not what the workspace sees, so the notice
    // names it.
    expect(progress.some((m) => m.startsWith('Ignoring') && m.includes('OPENCODE_CONFIG_DIR'))).toBe(true)
  })

  it('starts the session in one tmux call, where an option an older tmux lacks cannot fail it', async () => {
    vi.stubEnv('SHELL', '/bin/sh')
    await launchWorkspace(spec())
    expect(tmuxCalls()).toHaveLength(1)
    const [call = []] = tmuxCalls()
    // tmux stops a command list at its first error, so every option after
    // the session's own takes `-q`, which skips one it does not know.
    const commands = call.join(' ').split(' ; ')
    const cosmetic = commands.slice(commands.findIndex((c) => c.includes('update-environment')) + 1)
      .filter((c) => c.startsWith('set-option'))
    expect(cosmetic.length).toBeGreaterThan(5)
    for (const c of cosmetic) expect(c.split(' ')[1]).toContain('q')
    // Agent launches run under a shell that reads no rc file; panes start
    // the user's own. Both before the session: a respawn keeps the shell its
    // pane was created with.
    const session = commands.findIndex((c) => c.startsWith('new-session'))
    for (const option of ['set-option -g default-shell /bin/sh', 'set-option -g default-command exec \'/bin/sh\' -l']) {
      expect(commands.indexOf(option), option).toBeGreaterThan(-1)
      expect(commands.indexOf(option), option).toBeLessThan(session)
    }
    // The user's ~/.tmux.conf could set hooks, rename windows or end the
    // session, so the server reads none, as in a pod.
    expect(call.slice(0, 6)).toEqual(['tmux', '-S', call[2], '-f', '/dev/null', '-u'])
    // The pid is read in the same call.
    expect(commands.at(-1)).toBe('display-message -p #{pid}')

    // With no $SHELL, the one found on PATH is named by its full path.
    vi.stubEnv('SHELL', undefined)
    mockRunHost.mockClear()
    await launchWorkspace(spec())
    const shell = tmuxCalls()[0]?.join(' ').split(' ; ').find((c) => c.includes('default-command'))
    expect(shell).toMatch(/^set-option -g default-command exec '\/\S+\/(zsh|bash|sh)' (-l|--rcfile \S+)$/)
  })

  it('runs launches and panes in the user\'s shell, through startup files that put yaac\'s settings back after theirs', async () => {
    // The user's rc runs in their shell, and may export its own tool homes
    // or put its own claude first on PATH.
    const bin = path.join(dataDir, 'shells')
    await fsp.mkdir(bin)
    for (const name of ['zsh', 'bash', 'fish']) await fsp.writeFile(path.join(bin, name), '', { mode: 0o755 })
    const piSrc = path.join(dataDir, 'pi')
    const option = (name: string): string | undefined => tmuxCalls().at(-1)?.join(' ').split(' ; ')
      .find((c) => c.startsWith(`set-option -g ${name} `))?.replace(`set-option -g ${name} `, '')
    const defaultCommand = (): string | undefined => option('default-command')

    vi.stubEnv('SHELL', path.join(bin, 'zsh'))
    vi.stubEnv('ZDOTDIR', path.join(dataDir, 'my-zsh'))
    await launchWorkspace(spec({
      mounts: [{ source: { kind: 'hostPath', path: piSrc }, mountPath: '/home/yaac/.pi' }],
      env: ['PI_CODING_AGENT_DIR=/home/yaac/.pi/agent', 'GH_TOKEN=gho_project'],
      secretEnvKeys: ['GH_TOKEN'],
    }))
    // zsh runs every launch too (`zsh -c`), reading its startup files from
    // ZDOTDIR.
    expect(option('default-shell')).toBe(path.join(bin, 'zsh'))
    expect(defaultCommand()).toBe(`exec '${path.join(bin, 'zsh')}' -l`)
    expect(sessionEnv()).toMatchObject({
      SHELL: path.join(bin, 'zsh'),
      ZDOTDIR: path.join(stateDir(), 'zsh'),
      YAAC_USER_ZDOTDIR: path.join(dataDir, 'my-zsh'),
    })
    // The workspace's own dir, linking the shipped files, so what zsh
    // writes there (a global compinit's dump) stays out of the install.
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      expect(await fsp.readlink(path.join(stateDir(), 'zsh', name))).toBe(path.join(hostShellDir(), 'zsh', name))
    }
    // Recorded, so a restarted server's commands start init windows in it.
    const marker = JSON.parse(await fsp.readFile(path.join(stateDir(), 'workspace.json'), 'utf8')) as
      { launchEnv: Record<string, string> }
    expect(marker.launchEnv.SHELL).toBe(path.join(bin, 'zsh'))

    // What the startup files re-apply after each of the user's rc files.
    const { stdout } = await execFileAsync('/bin/sh', ['-c', '. "$0"; printf "%s\\n" "$PI_CODING_AGENT_DIR" "${OPENCODE_CONFIG_DIR-unset}" "$PATH"', sessionEnv().YAAC_SHELL_ENV ?? ''], {
      env: { PATH: '/their/bin', PI_CODING_AGENT_DIR: '/their/pi', OPENCODE_CONFIG_DIR: '/their/opencode' },
    })
    expect(stdout.split('\n')).toEqual([
      path.join(piSrc, 'agent'),
      'unset',
      `${sessionEnv().PATH?.split(path.delimiter).slice(0, 1 + agentBinDirs().length).join(path.delimiter)}:/their/bin`,
      '',
    ])
    // Every entry the launch set is put back, credentials included, so the
    // file is owner-only; a non-interactive bash reads it as BASH_ENV.
    const shellEnv = sessionEnv().YAAC_SHELL_ENV ?? ''
    expect(sessionEnv().BASH_ENV).toBe(shellEnv)
    expect(await fsp.readFile(shellEnv, 'utf8')).toContain('export GH_TOKEN=\'gho_project\'')
    expect((await fsp.stat(shellEnv)).mode & 0o777).toBe(0o600)

    // bash runs launches as `bash -c`, which reads BASH_ENV. A pane's bash
    // reads an rcfile only when not a login shell, so it gets one that reads
    // the login files itself. A zsh an agent starts still goes through
    // yaac's files.
    vi.stubEnv('SHELL', path.join(bin, 'bash'))
    await launchWorkspace(spec())
    expect(option('default-shell')).toBe(path.join(bin, 'bash'))
    expect(defaultCommand()).toBe(`exec '${path.join(bin, 'bash')}' --rcfile '${path.join(hostShellDir(), 'bash', 'rc')}'`)
    expect(sessionEnv().ZDOTDIR).toBe(path.join(stateDir(), 'zsh'))

    // fish reads config.fish after anything yaac can put in its way but a
    // `-C`, which a launch cannot pass: launches run under /bin/sh, which
    // reads no rc, and a pane re-applies through `-C`, in fish's syntax.
    vi.stubEnv('SHELL', path.join(bin, 'fish'))
    await launchWorkspace(spec({ env: ['QUOTED=it\'s a \\ path'] }))
    const fishEnv = path.join(stateDir(), 'shell-env.fish')
    expect(option('default-shell')).toBe('/bin/sh')
    expect(defaultCommand()).toBe(`exec '${path.join(bin, 'fish')}' -l -C 'source '\\''${fishEnv}'\\'''`)
    const fishScript = await fsp.readFile(fishEnv, 'utf8')
    expect(fishScript).toContain('set -gx QUOTED \'it\\\'s a \\\\ path\'\n')
    expect(fishScript).toContain('set -e OPENCODE_CONFIG_DIR\n')
    expect(fishScript).toMatch(/^test "\$PATH\[1\]" = '[^']+'; or set -gx PATH ('[^']+' )+\$PATH$/m)
    expect((await fsp.stat(fishEnv)).mode & 0o777).toBe(0o600)
  })

  // `-q` would also hide a misspelled option, so the call runs against the
  // real tmux without it: every option it sets must be one tmux knows.
  it.skipIf(!fs.existsSync('/usr/bin/tmux') && !fs.existsSync('/opt/homebrew/bin/tmux') && !fs.existsSync('/usr/local/bin/tmux'))(
    'sets only options tmux knows, with values it accepts',
    async () => {
      vi.stubEnv('SHELL', '/bin/sh')
      await launchWorkspace(spec())
      const [call = []] = tmuxCalls()
      const sock = path.join(dataDir, 'real.sock')
      // The call less its socket (`tmux -S <sock>`), with each `-q` dropped.
      const argv = call.slice(3).flatMap((arg) => (arg === '-q' ? [] : /^-[gs]qa?$/.test(arg) ? [arg.replace('q', '')] : [arg]))
      try {
        const { stdout } = await execFileAsync('tmux', ['-S', sock, ...argv])
        expect(Number(stdout.trim())).toBeGreaterThan(0)
        expect((await execFileAsync('tmux', ['-S', sock, 'show-options', '-gv', 'mouse'])).stdout.trim()).toBe('on')
      } finally {
        await execFileAsync('tmux', ['-S', sock, 'kill-server']).catch(() => {})
      }
    },
  )

  it('tears down what it started when its tmux call fails', async () => {
    mockRunHost.mockImplementation((argv: string[]) => {
      if (argv.includes('new-session')) return Promise.reject(new Error('not a suitable shell'))
      if (argv[0] === 'ssh-add' && argv[1] === '-L') return Promise.resolve({ stdout: 'ssh-ed25519 AAAAPUBLIC yaac\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const knownHosts = path.join(dataDir, 'global', 'projects', 'demo', 'known_hosts')
    await expect(launchWorkspace(spec({
      gitCredential: { kind: 'ssh', privateKey: PRIVATE_KEY },
      ssh: { knownHostsFile: knownHosts },
    }))).rejects.toThrow('not a suitable shell')
    // No marker exists yet, so nothing else would find either to stop it.
    expect(tmuxCalls().some((a) => a.includes('kill-server'))).toBe(true)
    expect(mockKillPids).toHaveBeenCalledWith([4242], 'SIGTERM')
    expect(listWorkspaces()).toEqual([])
  })
})
