import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockOnPath = vi.hoisted(() => vi.fn())
import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  onPath: mockOnPath,
  runHost: mockRunHost,
}))
import { assertHostCanLaunch, runHostCheck } from '#drivers/containerless/check'
import { WorkspaceExecError } from '#drivers/contract'
import type { ServerError } from '@yaac/shared/errors'
import { setDataDir } from '@yaac/shared/paths'
import { AGENT_PACKAGES, agentPackagePrefix } from '@yaac/shared/tool-install'

const byName = (results: Awaited<ReturnType<typeof runHostCheck>>, name: string) =>
  results.find((r) => r.name === name)

/** Cleared before each case below, since the row under test reports on
 *  whatever ambient environment a test run happens to have. Imported rather
 *  than restated so the reset cannot drift from the list under test. */
import { TOOL_HOME_VARS } from '#drivers/containerless/tool-homes'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-check-'))
  setDataDir(dataDir)
  mockOnPath.mockReset()
  mockRunHost.mockReset()
  mockOnPath.mockResolvedValue(true)
  mockRunHost.mockResolvedValue({ stdout: 'tmux 3.4\n', stderr: '' })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** Where yaac's own install of `binary` lives. */
const managedBin = (binary: string): string =>
  path.join(agentPackagePrefix(AGENT_PACKAGES[binary]), 'bin', binary)

/** Binaries yaac installed on an earlier create. */
function preinstalled(...binaries: string[]): void {
  for (const binary of binaries) {
    fs.mkdirSync(path.dirname(managedBin(binary)), { recursive: true })
    fs.writeFileSync(managedBin(binary), '#!/bin/sh\n', { mode: 0o755 })
  }
}

/**
 * npm, as `runHost` meets it: `npm install --global --prefix <dir> … <spec>`
 * lands every binary of the package named by `spec` in `<dir>/bin`. The
 * specs it was asked for are returned, in order.
 */
function fakeNpm(): string[] {
  const specs: string[] = []
  mockRunHost.mockImplementation(async (argv: string[]) => {
    if (argv[0] !== 'npm') return { stdout: 'tmux 3.4\n', stderr: '' }
    const spec = argv[argv.length - 1]
    specs.push(spec)
    await new Promise((r) => setTimeout(r, 10))
    const prefix = argv[argv.indexOf('--prefix') + 1]
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true })
    for (const [binary, pkg] of Object.entries(AGENT_PACKAGES)) {
      if (`${pkg.package}@${pkg.version}` !== spec) continue
      fs.writeFileSync(path.join(prefix, 'bin', binary), '#!/bin/sh\n', { mode: 0o755 })
    }
    return { stdout: 'added 1 package', stderr: '' }
  })
  return specs
}

const specOf = (binary: string): string =>
  `${AGENT_PACKAGES[binary].package}@${AGENT_PACKAGES[binary].version}`

describe('runHostCheck', () => {
  it('passes a host that has everything a worktree needs', async () => {
    const results = await runHostCheck()
    expect(results.some((r) => r.status === 'fail')).toBe(false)
    expect(byName(results, 'tmux')?.status).toBe('pass')
    expect(byName(results, 'git')?.status).toBe('pass')
  })

  it('fails on a missing tmux, which nothing here can run without', async () => {
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin !== 'tmux'))
    const results = await runHostCheck()
    const tmux = byName(results, 'tmux')
    expect(tmux?.status).toBe('fail')
    // A check that says what is wrong without saying what to do is a worse
    // error message than the spawn failure it replaced.
    expect(tmux?.fix).toMatch(/install tmux/i)
  })

  it('only warns about what degrades a feature rather than the mode', async () => {
    mockOnPath.mockImplementation((bin: string) =>
      Promise.resolve(bin !== 'lsof' && bin !== 'socat'))
    const results = await runHostCheck()
    // Worktrees run fine without either: you lose port links and ACP mode.
    expect(byName(results, 'lsof')?.status).toBe('warn')
    expect(byName(results, 'socat')?.status).toBe('warn')
    expect(results.some((r) => r.status === 'fail')).toBe(false)
  })

  it('fails a tmux older than 3.1, whose terminals cannot open', async () => {
    // Every webapp terminal sets `window-size latest`, which 3.0 rejects.
    for (const [v, status] of [['2.8', 'fail'], ['3.0a', 'fail'], ['3.1c', 'pass'], ['next-3.6', 'pass'], ['master', 'pass']]) {
      mockRunHost.mockResolvedValue({ stdout: `tmux ${v}\n`, stderr: '' })
      expect(byName(await runHostCheck(), 'tmux version')?.status, v).toBe(status)
    }
  })

  it('fails on a missing node, which installs and runs the agents', async () => {
    // The case this exists for: a yaac whose server runs a bundled
    // interpreter whose dir never lands on PATH. Every create then refuses.
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin !== 'node'))
    const node = byName(await runHostCheck(), 'node')
    expect(node?.status).toBe('fail')
    // The node a distro's apt installs is too old for the pinned agents and
    // comes without npm, so "install node" alone would not fix the host.
    expect(node?.fix).toMatch(/node 22 or newer, with npm/)
  })

  it('warns about curl, which only the in-session helper needs', async () => {
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin !== 'curl'))
    const results = await runHostCheck()
    // yaac-mama posts to the server with it; a worktree with no curl still
    // runs its agent, so this can never be what fails a host.
    expect(byName(results, 'curl')?.status).toBe('warn')
    expect(byName(results, 'curl')?.fix).toMatch(/yaac-mama/)
    expect(results.some((r) => r.status === 'fail')).toBe(false)
  })

  it('lists the agents yaac has installed, and asks only for the npm that installs the rest', async () => {
    preinstalled('codex')
    const row = byName(await runHostCheck(), 'agent tools')
    expect(row?.status).toBe('pass')
    expect(row?.detail).toContain(`codex ${AGENT_PACKAGES.codex.version}`)
    expect(row?.detail).not.toContain('claude')
    expect(row?.detail).toMatch(/first time a worktree needs it/)

    // Without npm, a create naming anything not yet installed is refused.
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin !== 'npm'))
    const noNpm = byName(await runHostCheck(), 'agent tools')
    expect(noNpm?.status).toBe('warn')
    expect(noNpm?.fix).toMatch(/install node/i)
  })

  it('reports a host whose own environment re-points a tool home', async () => {
    // Worktrees drop these, which is right and invisible: nothing inside a
    // worktree looks different, so a user whose shell has said for years
    // that opencode lives elsewhere would never learn yaac disagrees.
    const saved = { ...process.env }
    for (const key of TOOL_HOME_VARS) delete process.env[key]
    process.env.XDG_CONFIG_HOME = '/home/someone/.config'
    process.env.CODEX_HOME = '/home/someone/.codex'
    let row
    try {
      row = byName(await runHostCheck(), 'tool home overrides')
    } finally {
      process.env = saved
    }
    expect(row?.status).toBe('warn')
    expect(row?.detail).toContain('XDG_CONFIG_HOME')
    expect(row?.detail).toContain('CODEX_HOME')
    // Named individually, because "some of your variables" sends a reader
    // hunting through a shell profile for which ones.
    expect(row?.detail).not.toContain('XDG_CACHE_HOME')
    expect(row?.fix).toMatch(/private HOME/)
  })

  it('passes the tool-home row on a host that sets none of them', async () => {
    const saved = { ...process.env }
    for (const key of TOOL_HOME_VARS) delete process.env[key]
    // Empty is not set: every tool here reads an empty value as absent, so
    // warning about one would report something that changes nothing.
    process.env.XDG_DATA_HOME = ''
    let row
    try {
      row = byName(await runHostCheck(), 'tool home overrides')
    } finally {
      process.env = saved
    }
    expect(row?.status).toBe('pass')
  })

  it('says plainly that nothing here is sandboxed', async () => {
    // The single most important thing a reader of this output has to know,
    // and it is not derivable from any of the checks above.
    const isolation = byName(await runHostCheck(), 'isolation')
    expect(isolation?.status).toBe('warn')
    expect(isolation?.detail).toMatch(/agents run as this user/)
  })
})

/**
 * The create's preflight. Everything here is the same failure — a launch
 * command that execs nothing, exits 127, and takes the worktree with it
 * seconds after a create that already reported success — caught before
 * anything is provisioned instead of after.
 */
describe('assertHostCanLaunch', () => {
  /** The inverse of what the host has, for the system tools it supplies. */
  const missing = (...bins: string[]) =>
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(!bins.includes(bin)))

  it('refuses any launch on a host with no tmux, before a thing is provisioned', async () => {
    // Otherwise this surfaces from inside launchWorkspace as a bare spawn
    // ENOENT — after the workspace home, its mounts and its state dir exist,
    // under a create that already reported progress.
    missing('tmux')
    const err = await assertHostCanLaunch({ tool: 'codex', mode: 'tui' })
      .catch((e: unknown) => e) as ServerError
    expect(err.code).toBe('MISSING_TOOL')
    expect(err.message).toMatch(/"tmux" is not on this host's PATH/)
    expect(err.message).toContain('brew install tmux')
    // And nothing to fall back to: this substrate IS tmux over a checkout,
    // so an invented alternative would only mislead.
    expect(err.message).not.toMatch(/, or /)
    expect(mockRunHost).not.toHaveBeenCalled()
  })

  it('refuses a launch on a host with no git, which makes the checkout', async () => {
    missing('git')
    const err = await assertHostCanLaunch({ tool: 'codex', mode: 'tui' })
      .catch((e: unknown) => e) as ServerError
    expect(err.code).toBe('MISSING_TOOL')
    expect(err.message).toMatch(/"git" is not on this host's PATH/)
    expect(err.message).toContain('brew install git')
  })

  it('reports the most fundamental gap first, so a host is fixed bottom-up', async () => {
    // A bare machine is missing all of these; being told about socat while
    // there is no tmux to run anything in helps nobody.
    missing('tmux', 'git', 'socat')
    await expect(assertHostCanLaunch({ tool: 'claude', mode: 'acp' }))
      .rejects.toThrow(/"tmux" is not on this host's PATH/)
  })

  it('installs the pinned tool on first use, and never the host\'s own', async () => {
    // Every binary resolves on this host's PATH, codex included: a codex the
    // user installed is at whatever version they last updated it to, which
    // is how a launch meets an update screen or a dropped policy.
    const specs = fakeNpm()
    const progress: string[] = []
    await assertHostCanLaunch({ tool: 'codex', mode: 'tui', onProgress: (m) => progress.push(m) })
    expect(specs).toEqual([specOf('codex')])
    expect(fs.statSync(managedBin('codex')).mode & 0o111).not.toBe(0)
    // A first create waits on a download, and says so.
    expect(progress.join('\n')).toContain(specOf('codex'))
    // Into its own prefix, and from there on the prefix is the answer.
    const npm = mockRunHost.mock.calls.find(([argv]) => (argv as string[])[0] === 'npm')?.[0] as string[]
    expect(npm[npm.indexOf('--prefix') + 1]).toMatch(/\.partial-/)
    await assertHostCanLaunch({ tool: 'codex', mode: 'tui' })
    expect(specs).toHaveLength(1)
    // Nothing of the staging dir is left beside the install.
    expect(fs.readdirSync(path.dirname(agentPackagePrefix(AGENT_PACKAGES.codex))))
      .toEqual([path.basename(agentPackagePrefix(AGENT_PACKAGES.codex))])
  })

  it('installs under the constraints third-party install code should run with', async () => {
    fakeNpm()
    process.env.YAAC_SECRETS = 'must-not-reach-npm'
    try {
      await assertHostCanLaunch({ tool: 'pi', mode: 'tui' })
      await assertHostCanLaunch({ tool: 'claude', mode: 'tui' })
    } finally {
      delete process.env.YAAC_SECRETS
    }
    const npm = mockRunHost.mock.calls.filter(([argv]) => (argv as string[])[0] === 'npm')
    const [pi, claude] = npm.map(([argv]) => argv as string[])
    // npm only warns about a node older than a package's `engines`, and the
    // install it then finishes would read as installed for good.
    expect(pi).toContain('--engine-strict')
    // Lifecycle scripts only where one puts the binary in place.
    expect(pi).toContain('--ignore-scripts')
    expect(claude).not.toContain('--ignore-scripts')
    // The server's own wiring stays with the server, as it does for a
    // workspace.
    for (const [, opts] of npm) {
      const env = (opts as { env: NodeJS.ProcessEnv }).env
      expect(env.PATH).toBe(process.env.PATH)
      expect(Object.keys(env).filter((k) => k.startsWith('YAAC_'))).toEqual([])
    }
  })

  it('clears staging an abandoned install left, and only that', async () => {
    // A server stopped mid-install leaves npm to finish into a staging dir
    // nothing will rename. One younger than the install timeout may be an
    // install still running, here or in a second server on this data dir.
    const dir = path.dirname(agentPackagePrefix(AGENT_PACKAGES.codex))
    const stale = path.join(dir, 'claude-code@1.0.0.partial-dead')
    const live = path.join(dir, 'pi-acp@1.0.0.partial-busy')
    fs.mkdirSync(path.join(stale, 'lib'), { recursive: true })
    fs.mkdirSync(live, { recursive: true })
    const old = new Date(Date.now() - 11 * 60_000)
    fs.utimesSync(stale, old, old)
    fakeNpm()
    await assertHostCanLaunch({ tool: 'codex', mode: 'tui' })
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(live)).toBe(true)
  })

  it('installs the ADAPTER under acp, and the tool too only when the adapter drives one', async () => {
    const specs = fakeNpm()
    // claude-agent-acp bundles its own SDK; acpd never shells out to `claude`.
    await assertHostCanLaunch({ tool: 'claude', mode: 'acp' })
    expect(specs).toEqual([specOf('claude-agent-acp')])

    // codex-acp spawns `codex app-server`, so a host with the adapter and no
    // CLI fails at the first prompt rather than at the launch — later, and
    // with nothing to point at.
    specs.length = 0
    await assertHostCanLaunch({ tool: 'codex', mode: 'acp' })
    expect(specs).toEqual([specOf('codex-acp'), specOf('codex')])

    // opencode IS its own adapter, so it is one install under one name.
    specs.length = 0
    await assertHostCanLaunch({ tool: 'opencode', mode: 'acp' })
    expect(specs).toEqual([specOf('opencode')])
  })

  it('asks for socat under acp, whose absence hangs a pane instead of failing', async () => {
    // The adapter alone gets a worktree that launches and never attaches:
    // the chat transport dials acpd's socket by spawning socat on this host,
    // so without it there is no handshake, no conversation and no pane —
    // which reads as a wedged agent rather than a missing tool.
    missing('socat')
    const err = await assertHostCanLaunch({ tool: 'claude', mode: 'acp' })
      .catch((e: unknown) => e) as ServerError
    expect(err.code).toBe('MISSING_TOOL')
    expect(err.message).toMatch(/"socat" is not on this host's PATH/)
    expect(err.message).toContain('apt install socat')
    expect(err.message).toContain('--mode tui')
    // Refused before the adapter's download, not after.
    expect(mockRunHost).not.toHaveBeenCalled()
  })

  it('asks for node whatever the mode, because the agents install and run under it', async () => {
    // npm installs every agent under it, codex and pi are node scripts, and
    // `node <acpdEntry>` is what an acp window runs. A server started by a
    // bundled node that never landed on PATH (the desktop app stages one)
    // launches a window that execs nothing and closes.
    missing('node')
    for (const mode of ['tui', 'acp'] as const) {
      const err = await assertHostCanLaunch({ tool: 'codex', mode })
        .catch((e: unknown) => e) as ServerError
      expect(err.code).toBe('MISSING_TOOL')
      expect(err.message).toMatch(/"node" is not on this host's PATH/)
      expect(err.message).toContain('node 22 or newer, with npm')
    }
    expect(mockRunHost).not.toHaveBeenCalled()
  })

  it('asks nothing about socat for tui, which dials no socket', async () => {
    preinstalled('codex')
    missing('socat')
    await expect(assertHostCanLaunch({ tool: 'codex', mode: 'tui' })).resolves.toBeUndefined()
    expect(mockRunHost).not.toHaveBeenCalled()
  })

  it('refuses an install on a host with no npm, naming what provides it', async () => {
    missing('npm')
    const err = await assertHostCanLaunch({ tool: 'codex', mode: 'tui' })
      .catch((e: unknown) => e) as ServerError
    expect(err.code).toBe('MISSING_TOOL')
    expect(err.message).toContain(specOf('codex'))
    expect(err.message).toContain('node 22 or newer, with npm')
  })

  it('reports the installer\'s own words when the install fails, and leaves nothing behind', async () => {
    // Shaped like a real npm failure on a node older than the package's
    // `engines`: the machine-readable code is printed near the TOP, and the
    // sentence a person needs is at the bottom, with more than a window's
    // worth of noise in between.
    const npmError = [
      'npm error code EBADENGINE',
      'npm error engine Unsupported engine',
      ...Array.from({ length: 12 }, (_, i) => `npm error   detail line ${String(i)}`),
      'npm error notsup Required: {"node":">=22.0.0"}',
    ].join('\n')
    mockRunHost.mockImplementation((argv: string[]) => {
      if (argv[0] !== 'npm') return Promise.resolve({ stdout: '', stderr: '' })
      fs.mkdirSync(path.join(argv[argv.indexOf('--prefix') + 1], 'lib'), { recursive: true })
      return Promise.reject(new WorkspaceExecError('command exited 1', 1, '', npmError))
    })
    const err = await assertHostCanLaunch({ tool: 'codex', mode: 'tui' })
      .catch((e: unknown) => e) as ServerError
    expect(err.code).toBe('MISSING_TOOL')
    expect(err.message).toContain(`installing ${specOf('codex')} failed`)
    expect(err.message).toContain('Required: {"node":">=22.0.0"}')
    // Lifted, not duplicated — the tail drops the code line it hoisted.
    expect(err.message.match(/npm error code EBADENGINE/g)).toHaveLength(1)
    // A half-written install must not pass for one on the next create.
    expect(fs.readdirSync(path.dirname(agentPackagePrefix(AGENT_PACKAGES.codex)))).toEqual([])
  })

  it('refuses an install that reports success but leaves no binary', async () => {
    mockRunHost.mockResolvedValue({ stdout: 'added 0 packages', stderr: '' })
    await expect(assertHostCanLaunch({ tool: 'codex', mode: 'tui' }))
      .rejects.toThrow(/left no "codex" binary behind/)
    expect(fs.existsSync(managedBin('codex'))).toBe(false)
  })

  it('runs one install for concurrent creates wanting the same tool', async () => {
    // Two npm runs into one prefix race each other's writes, and the second
    // has nothing to add.
    const specs = fakeNpm()
    await Promise.all([
      assertHostCanLaunch({ tool: 'codex', mode: 'tui' }),
      assertHostCanLaunch({ tool: 'codex', mode: 'tui' }),
    ])
    expect(specs).toEqual([specOf('codex')])
  })
})
