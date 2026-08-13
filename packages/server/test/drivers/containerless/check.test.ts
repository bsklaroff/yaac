import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockOnPath = vi.hoisted(() => vi.fn())
import type * as hostModule from '#drivers/containerless/host'

const mockRunHost = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  onPath: mockOnPath,
  runHost: mockRunHost,
}))
import { acpAdapterRunnable, runHostCheck } from '#drivers/containerless/check'

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

describe('acpAdapterRunnable', () => {
  it('answers from PATH, which is what a create asks before recording anything', async () => {
    // Without this the create reports success and the worktree is gone
    // seconds later: acpd execs an adapter that ships in the image and is
    // absent from a host, exits 127, and tmux closes the window with the
    // session in it.
    mockOnPath.mockImplementation((bin: string) =>
      Promise.resolve(bin === 'claude-agent-acp'))
    expect(await acpAdapterRunnable('claude-agent-acp')).toBe(true)
    expect(await acpAdapterRunnable('codex-agent-acp')).toBe(false)
  })
})
