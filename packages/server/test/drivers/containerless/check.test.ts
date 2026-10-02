import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
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

/** Cleared before each case, since the check reads the ambient
 *  environment. Imported so the reset matches the list under test. */
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

/** Mark binaries as installed by an earlier create. */
function preinstalled(...binaries: string[]): void {
  for (const binary of binaries) {
    fs.mkdirSync(path.dirname(managedBin(binary)), { recursive: true })
    fs.writeFileSync(managedBin(binary), '#!/bin/sh\n', { mode: 0o755 })
  }
}

/**
 * Fake `npm install --global --prefix <dir> … <spec>` through `runHost`: puts
 * the package's binaries in `<dir>/bin`. Returns the requested specs in
 * order.
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
  it('passes a host that has everything a workspace needs', async () => {
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
    // Every failure must say how to fix it.
    expect(tmux?.fix).toMatch(/install tmux/i)
  })

  it('only warns about what degrades a feature rather than the mode', async () => {
    mockOnPath.mockImplementation((bin: string) =>
      Promise.resolve(bin !== 'lsof' && bin !== 'socat'))
    const results = await runHostCheck()
    // Workspaces run without either, minus port links and ACP mode.
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
    // A server running a bundled node that is not on PATH: every create
    // would be refused.
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin !== 'node'))
    const node = byName(await runHostCheck(), 'node')
    expect(node?.status).toBe('fail')
    // A distro's node is often too old and lacks npm, so "install node" is
    // not enough.
    expect(node?.fix).toMatch(/node 22 or newer, with npm/)
  })

  it('warns about curl, which only the in-session helper needs', async () => {
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin !== 'curl'))
    const results = await runHostCheck()
    // yaac-mama uses curl, but agents run without it, so it only warns.
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
    expect(row?.detail).toMatch(/first time a workspace needs it/)

    // Without npm, a create naming anything not yet installed is refused.
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin !== 'npm'))
    const noNpm = byName(await runHostCheck(), 'agent tools')
    expect(noNpm?.status).toBe('warn')
    expect(noNpm?.fix).toMatch(/install node/i)
  })

  it('reports a host whose own environment re-points a tool home', async () => {
    // Workspaces drop these variables silently, so the check tells the user.
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
    // Each set variable is named individually.
    expect(row?.detail).not.toContain('XDG_CACHE_HOME')
    expect(row?.fix).toMatch(/private HOME/)
  })

  it('passes the tool-home row on a host that sets none of them', async () => {
    const saved = { ...process.env }
    for (const key of TOOL_HOME_VARS) delete process.env[key]
    // Empty counts as unset, as every tool here treats it.
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
    // The lack of isolation is the most important thing to report.
    const isolation = byName(await runHostCheck(), 'isolation')
    expect(isolation?.status).toBe('warn')
    expect(isolation?.detail).toMatch(/agents run as this user/)
  })
})

/**
 * The create's preflight. It catches, before anything is provisioned, a
 * launch command that would exec nothing and exit 127 seconds after the
 * create reported success.
 */
describe('assertHostCanLaunch', () => {
  /** Make the host lack these system binaries. */
  const missing = (...bins: string[]) =>
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(!bins.includes(bin)))

  it('refuses any launch on a host with no tmux, before a thing is provisioned', async () => {
    // Otherwise it surfaces as a bare spawn ENOENT inside launchWorkspace,
    // after the workspace's dirs already exist.
    missing('tmux')
    const err = await assertHostCanLaunch({ tool: 'codex', mode: 'tui' })
      .catch((e: unknown) => e) as ServerError
    expect(err.code).toBe('MISSING_TOOL')
    expect(err.message).toMatch(/"tmux" is not on this host's PATH/)
    expect(err.message).toContain('brew install tmux')
    // No alternative is offered; this driver requires tmux.
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
    // On a bare machine, tmux is reported first.
    missing('tmux', 'git', 'socat')
    await expect(assertHostCanLaunch({ tool: 'claude', mode: 'acp' }))
      .rejects.toThrow(/"tmux" is not on this host's PATH/)
  })

  it('installs the pinned tool on first use, and never the host\'s own', async () => {
    // Every binary is on PATH, codex included, but the user's codex may be
    // any version, so yaac installs its pinned one.
    const specs = fakeNpm()
    const progress: string[] = []
    await assertHostCanLaunch({ tool: 'codex', mode: 'tui', onProgress: (m) => progress.push(m) })
    expect(specs).toEqual([specOf('codex')])
    expect(fs.statSync(managedBin('codex')).mode & 0o111).not.toBe(0)
    // A first create reports the download.
    expect(progress.join('\n')).toContain(specOf('codex'))
    // Installed via a staging prefix; later creates reuse the install.
    const npm = mockRunHost.mock.calls.find(([argv]) => (argv as string[])[0] === 'npm')?.[0] as string[]
    expect(npm[npm.indexOf('--prefix') + 1]).toMatch(/\.partial-/)
    await assertHostCanLaunch({ tool: 'codex', mode: 'tui' })
    expect(specs).toHaveLength(1)
    // No staging dir is left behind.
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
    // Without this, npm only warns about an old node and the install would
    // count as done.
    expect(pi).toContain('--engine-strict')
    // Lifecycle scripts run only where one installs the binary.
    expect(pi).toContain('--ignore-scripts')
    expect(claude).not.toContain('--ignore-scripts')
    // The server's own env vars are not passed through.
    for (const [, opts] of npm) {
      const env = (opts as { env: NodeJS.ProcessEnv }).env
      expect(env.PATH).toBe(process.env.PATH)
      expect(Object.keys(env).filter((k) => k.startsWith('YAAC_'))).toEqual([])
    }
  })

  it('clears staging an abandoned install left, and only that', async () => {
    // A server stopped mid-install leaves a staging dir nothing will rename.
    // One younger than the install timeout may still be in use.
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

    // codex-acp spawns `codex app-server`, so without the CLI it would fail
    // at the first prompt instead of at launch.
    specs.length = 0
    await assertHostCanLaunch({ tool: 'codex', mode: 'acp' })
    expect(specs).toEqual([specOf('codex-acp'), specOf('codex')])

    // opencode is its own adapter, so it is one install.
    specs.length = 0
    await assertHostCanLaunch({ tool: 'opencode', mode: 'acp' })
    expect(specs).toEqual([specOf('opencode')])
  })

  it('patches pi-acp before it counts as installed, and installs nothing the patch refuses', async () => {
    // The patch runs for real on what the fake npm installs.
    let source = '#!/usr/bin/env node\nnot the pinned pi-acp\n'
    fakeNpm()
    const npm = mockRunHost.getMockImplementation() as (argv: string[], opts: unknown) => Promise<unknown>
    mockRunHost.mockImplementation(async (argv: string[], opts: unknown) => {
      if (argv[0] === 'node') {
        execFileSync(process.execPath, argv.slice(1), { stdio: 'pipe' })
        return { stdout: '', stderr: '' }
      }
      const result = await npm(argv, opts)
      if (argv[0] === 'npm' && argv.at(-1) === specOf('pi-acp')) {
        const entry = path.join(argv[argv.indexOf('--prefix') + 1], 'lib', 'node_modules', 'pi-acp', 'dist', 'index.js')
        fs.mkdirSync(path.dirname(entry), { recursive: true })
        fs.writeFileSync(entry, source)
      }
      return result
    })
    const prefix = agentPackagePrefix(AGENT_PACKAGES['pi-acp'])

    await expect(assertHostCanLaunch({ tool: 'pi', mode: 'acp' })).rejects.toThrow(/patching pi-acp@\S+ failed/)
    expect(fs.existsSync(prefix)).toBe(false)

    const require = createRequire(import.meta.url)
    source = fs.readFileSync(path.join(path.dirname(require.resolve('pi-acp/package.json')), 'dist', 'index.js'), 'utf8')
    await assertHostCanLaunch({ tool: 'pi', mode: 'acp' })
    expect(fs.readFileSync(path.join(prefix, 'lib', 'node_modules', 'pi-acp', 'dist', 'index.js'), 'utf8'))
      .toContain('"_session/steering"')
  })

  it('asks for socat under acp, whose absence hangs a pane instead of failing', async () => {
    // The chat transport reaches acpd's socket by spawning socat. Without
    // it the workspace launches but never attaches, which looks like a
    // wedged agent.
    missing('socat')
    const err = await assertHostCanLaunch({ tool: 'claude', mode: 'acp' })
      .catch((e: unknown) => e) as ServerError
    expect(err.code).toBe('MISSING_TOOL')
    expect(err.message).toMatch(/"socat" is not on this host's PATH/)
    expect(err.message).toContain('apt install socat')
    expect(err.message).toContain('--mode tui')
    // Refused before downloading the adapter.
    expect(mockRunHost).not.toHaveBeenCalled()
  })

  it('asks for node whatever the mode, because the agents install and run under it', async () => {
    // npm, the codex and pi scripts, and acpd all need node on PATH. A
    // server using a bundled node (as the desktop app does) may lack it.
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
    // Like a real EBADENGINE failure: the error code near the top, the
    // useful sentence at the bottom, and lots of noise between.
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
    // The code line is moved to the top, not duplicated.
    expect(err.message.match(/npm error code EBADENGINE/g)).toHaveLength(1)
    // A half-written install is removed.
    expect(fs.readdirSync(path.dirname(agentPackagePrefix(AGENT_PACKAGES.codex)))).toEqual([])
  })

  it('refuses an install that reports success but leaves no binary', async () => {
    mockRunHost.mockResolvedValue({ stdout: 'added 0 packages', stderr: '' })
    await expect(assertHostCanLaunch({ tool: 'codex', mode: 'tui' }))
      .rejects.toThrow(/left no "codex" binary behind/)
    expect(fs.existsSync(managedBin('codex'))).toBe(false)
  })

  it('runs one install for concurrent creates wanting the same tool', async () => {
    // Concurrent npm runs into one prefix would race, so they are shared.
    const specs = fakeNpm()
    await Promise.all([
      assertHostCanLaunch({ tool: 'codex', mode: 'tui' }),
      assertHostCanLaunch({ tool: 'codex', mode: 'tui' }),
    ])
    expect(specs).toEqual([specOf('codex')])
  })
})
