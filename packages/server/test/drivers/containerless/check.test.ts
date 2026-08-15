import { describe, it, expect, vi, beforeEach } from 'vitest'

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
import { MissingToolError, ServerError } from '@yaac/shared/errors'
import { AGENT_INSTALL } from '@yaac/shared/tool-install'

const byName = (results: Awaited<ReturnType<typeof runHostCheck>>, name: string) =>
  results.find((r) => r.name === name)

beforeEach(() => {
  mockOnPath.mockReset()
  mockRunHost.mockReset()
  mockOnPath.mockResolvedValue(true)
  mockRunHost.mockResolvedValue({ stdout: 'tmux 3.4\n', stderr: '' })
})

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

  it('warns about a tmux too old to drive control mode', async () => {
    // The status watcher attaches with `-C`; on tmux 2.x an agent's status
    // silently never updates.
    mockRunHost.mockResolvedValue({ stdout: 'tmux 2.8\n', stderr: '' })
    expect(byName(await runHostCheck(), 'tmux version')?.status).toBe('warn')
  })

  it('warns when no agent CLI is installed, since there is no image to supply one', async () => {
    mockOnPath.mockImplementation((bin: string) =>
      Promise.resolve(['tmux', 'git', 'lsof', 'socat'].includes(bin)))
    const agents = byName(await runHostCheck(), 'agent CLIs')
    expect(agents?.status).toBe('warn')
    expect(agents?.detail).toContain('none found')
  })

  it('reports the ACP adapters, which are separate packages from the agents', async () => {
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin !== 'claude-agent-acp'))
    const adapters = byName(await runHostCheck(), 'ACP adapters')
    expect(adapters?.status).toBe('warn')
    // Learned here rather than from a worktree that vanishes seconds after
    // a create that reported success.
    expect(adapters?.fix).toMatch(/claude-agent-acp/)
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
  const present = (...bins: string[]) =>
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bins.includes(bin)))

  it('passes a tui launch whose tool is on PATH', async () => {
    present('codex')
    await expect(assertHostCanLaunch({ tool: 'codex', mode: 'tui' })).resolves.toBeUndefined()
  })

  it('refuses a tui launch whose tool is missing, with the command that fixes it', async () => {
    present()
    const err = await assertHostCanLaunch({ tool: 'codex', mode: 'tui' }).catch((e: unknown) => e)
    // A code, not just prose: the webapp offers to run the install off it.
    expect(err).toBeInstanceOf(ServerError)
    expect((err as ServerError).code).toBe('MISSING_TOOL')
    // An error that says only what is wrong is barely better than the spawn
    // failure it replaces.
    expect((err as ServerError).message).toContain(AGENT_INSTALL.codex)
    expect((err as ServerError).message).toContain('--install-missing')
    // And says so in a form a client can act on — this is the case where an
    // Install-and-retry button really can fix it.
    expect((err as MissingToolError).installable).toBe(true)
  })

  it('asks for the ADAPTER under acp, not the tool it adapts', async () => {
    // claude-agent-acp bundles its own SDK; acpd never shells out to
    // `claude`, so a host with the adapter and no CLI runs acp fine.
    present('claude-agent-acp', 'socat')
    await expect(assertHostCanLaunch({ tool: 'claude', mode: 'acp' })).resolves.toBeUndefined()

    present('claude', 'socat')
    await expect(assertHostCanLaunch({ tool: 'claude', mode: 'acp' }))
      .rejects.toThrow(/claude-agent-acp.*not on this host's PATH/)
  })

  it('asks for socat under acp, whose absence hangs a pane instead of failing', async () => {
    // The adapter alone gets a worktree that launches and never attaches:
    // the chat transport dials acpd's socket by spawning socat on this host,
    // so without it there is no handshake, no conversation and no pane —
    // which reads as a wedged agent rather than a missing tool.
    present('claude-agent-acp')
    const err = await assertHostCanLaunch({ tool: 'claude', mode: 'acp' })
      .catch((e: unknown) => e) as ServerError
    expect(err.code).toBe('MISSING_TOOL')
    expect(err.message).toMatch(/"socat" is not on this host's PATH/)
    // No npm package carries socat, so the recovery is the system one and an
    // `--install-missing` offer yaac could not honour is left unsaid.
    expect(err.message).toContain('apt install socat')
    expect(err.message).toContain('--mode tui')
    expect(err.message).not.toContain('--install-missing')
    // The same fact in a form a client can branch on: the webapp offers its
    // Install-and-retry button off this, not off the code, because a retry
    // that installs nothing re-fails with this identical error.
    expect(err).toBeInstanceOf(MissingToolError)
    expect((err as MissingToolError).installable).toBe(false)

    // And an install run cannot paper over it either.
    await expect(assertHostCanLaunch({ tool: 'claude', mode: 'acp', installMissing: true }))
      .rejects.toThrow(/"socat" is not on this host's PATH/)
    expect(mockRunHost).not.toHaveBeenCalled()
  })

  it('leaves socat alone for tui, which never dials a socket', async () => {
    present('claude')
    await expect(assertHostCanLaunch({ tool: 'claude', mode: 'tui' })).resolves.toBeUndefined()
  })

  it('refuses acp for a tool that has no adapter at all', async () => {
    present()
    await expect(assertHostCanLaunch({ tool: 'codex', mode: 'acp' }))
      .rejects.toThrow(/no ACP adapter/)
  })

  it('installs a missing tool when asked to, then proves it landed', async () => {
    // `npm -g` reports success into prefixes this server's PATH never
    // searches, so the re-probe is what separates a real install from a
    // worktree that will die exactly as it would have.
    let installed = false
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin === 'codex' && installed))
    mockRunHost.mockImplementation((argv: string[]) => {
      expect(argv).toEqual(['sh', '-c', AGENT_INSTALL.codex])
      installed = true
      return Promise.resolve({ stdout: 'added 1 package', stderr: '' })
    })
    const progress: string[] = []
    await expect(assertHostCanLaunch({
      tool: 'codex', mode: 'tui', installMissing: true, onProgress: (m) => progress.push(m),
    })).resolves.toBeUndefined()
    expect(mockRunHost).toHaveBeenCalledTimes(1)
    expect(progress.join('\n')).toContain(AGENT_INSTALL.codex)
  })

  it('installs nothing when the tool is already there', async () => {
    present('codex')
    await assertHostCanLaunch({ tool: 'codex', mode: 'tui', installMissing: true })
    expect(mockRunHost).not.toHaveBeenCalled()
  })

  it('reports the installer\'s own words when the install fails', async () => {
    present()
    mockRunHost.mockRejectedValue(
      new WorkspaceExecError('command exited 243', 243, '', 'npm ERR! EACCES /usr/lib/node_modules'),
    )
    // Where "needs a writable prefix" actually lives — without it the user
    // gets a second silent failure instead of a fixable one.
    await expect(assertHostCanLaunch({ tool: 'codex', mode: 'tui', installMissing: true }))
      .rejects.toThrow(/installing codex failed.*EACCES/s)
  })

  it('keeps npm\'s code line, which a tail-only window would scroll off', async () => {
    present()
    // Shaped like a real npm failure: the machine-readable code is printed
    // near the TOP, and the sentence a person needs is at the bottom, with
    // more than a window's worth of path noise in between.
    const npmError = [
      'npm error code EACCES',
      'npm error syscall mkdir',
      "npm error path '/ro-prefix/lib'",
      ...Array.from({ length: 12 }, (_, i) => `npm error   detail line ${String(i)}`),
      'npm error The operation was rejected by your operating system.',
      'npm error It is likely you do not have the permissions to access this file.',
    ].join('\n')
    mockRunHost.mockRejectedValue(new WorkspaceExecError('command exited 243', 243, '', npmError))
    const err = await assertHostCanLaunch({ tool: 'codex', mode: 'tui', installMissing: true })
      .catch((e: unknown) => e) as Error
    expect(err.message).toContain('npm error code EACCES')
    expect(err.message).toContain('do not have the permissions')
    // Lifted, not duplicated — the tail drops the code line it hoisted.
    expect(err.message.match(/npm error code EACCES/g)).toHaveLength(1)
  })

  it('refuses when the install reports success but the binary still is not on PATH', async () => {
    present()
    mockRunHost.mockResolvedValue({ stdout: 'added 1 package', stderr: '' })
    await expect(assertHostCanLaunch({ tool: 'codex', mode: 'tui', installMissing: true }))
      .rejects.toThrow(/still not on this server's PATH/)
  })

  it('runs one install for concurrent creates wanting the same tool', async () => {
    // Two `npm -g` runs into one prefix race each other's writes, and the
    // second has nothing to add.
    let installed = false
    mockOnPath.mockImplementation((bin: string) => Promise.resolve(bin === 'codex' && installed))
    mockRunHost.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10))
      installed = true
      return { stdout: '', stderr: '' }
    })
    await Promise.all([
      assertHostCanLaunch({ tool: 'codex', mode: 'tui', installMissing: true }),
      assertHostCanLaunch({ tool: 'codex', mode: 'tui', installMissing: true }),
    ])
    expect(mockRunHost).toHaveBeenCalledTimes(1)
  })
})
