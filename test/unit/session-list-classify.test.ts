import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifySessionContainers, resolveStartingGraceMs, STARTING_GRACE_MS } from '@/lib/session/list'

const NOW = 1_800_000_000_000
const now = (): number => NOW

function container(overrides: {
  id?: string
  name?: string
  sessionId?: string
  project?: string
  state?: string
  ageMs?: number
}) {
  const createdSec = overrides.ageMs === undefined
    ? Math.floor(NOW / 1000) - Math.ceil(STARTING_GRACE_MS / 1000) - 1
    : Math.floor((NOW - overrides.ageMs) / 1000)
  return {
    Id: overrides.id ?? 'id-' + (overrides.name ?? 'c'),
    Names: [`/${overrides.name ?? 'yaac-proj-s1'}`],
    Labels: {
      'yaac.session-id': overrides.sessionId ?? 's1',
      'yaac.project': overrides.project ?? 'proj',
    },
    State: overrides.state ?? 'running',
    Created: createdSec,
  }
}

describe('classifySessionContainers', () => {
  it('puts running containers with live tmux into the running bucket', async () => {
    const c = container({})
    const result = await classifySessionContainers([c], now(), () => Promise.resolve(true))
    expect(result.running).toEqual([c])
    expect(result.stale).toEqual([])
  })

  it('classifies old running-but-no-tmux containers as zombie stale', async () => {
    const c = container({ name: 'yaac-proj-zombie', sessionId: 'z1' })
    const result = await classifySessionContainers([c], now(), () => Promise.resolve(false))
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([
      { containerName: 'yaac-proj-zombie', projectSlug: 'proj', sessionId: 'z1', zombie: true },
    ])
  })

  it('classifies old exited containers as non-zombie stale', async () => {
    const c = container({ name: 'yaac-proj-dead', sessionId: 'd1', state: 'exited' })
    const result = await classifySessionContainers([c], now(), () => Promise.resolve(true))
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([
      { containerName: 'yaac-proj-dead', projectSlug: 'proj', sessionId: 'd1', zombie: false },
    ])
  })

  it('skips young running-but-no-tmux containers during the startup grace window', async () => {
    // Simulates session-create attempt N with the container up but tmux
    // not yet started. Reaping this would clobber the proxy session.
    const c = container({ name: 'yaac-proj-new', state: 'running', ageMs: STARTING_GRACE_MS - 1_000 })
    const isTmuxAlive = vi.fn().mockResolvedValue(false)
    const result = await classifySessionContainers([c], now(), isTmuxAlive)
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('skips young exited containers so a retry can recreate them safely', async () => {
    // Simulates the window between attempt N dying and the retry loop
    // firing `podman rm -f`. The reaper must not race with it.
    const c = container({ state: 'exited', ageMs: STARTING_GRACE_MS - 1_000 })
    const result = await classifySessionContainers([c], now(), () => Promise.resolve(true))
    expect(result.running).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('reaps a container that has been running without tmux past the grace window', async () => {
    const c = container({ name: 'yaac-proj-stuck', ageMs: STARTING_GRACE_MS + 5_000 })
    const result = await classifySessionContainers([c], now(), () => Promise.resolve(false))
    expect(result.stale).toEqual([
      { containerName: 'yaac-proj-stuck', projectSlug: 'proj', sessionId: 's1', zombie: true },
    ])
  })

  it('treats missing Created as old so legacy entries do not leak forever', async () => {
    const c = { ...container({ state: 'exited' }), Created: undefined as number | undefined }
    const result = await classifySessionContainers([c], now(), () => Promise.resolve(true))
    expect(result.stale).toHaveLength(1)
    expect(result.stale[0].zombie).toBe(false)
  })

  it('falls back to Id when Names is missing, and tolerates empty labels', async () => {
    const c = {
      Id: 'abc123',
      Names: undefined as string[] | undefined,
      Labels: undefined as Record<string, string> | undefined,
      State: 'exited',
      Created: Math.floor((NOW - STARTING_GRACE_MS - 1_000) / 1000),
    }
    const result = await classifySessionContainers([c], now(), () => Promise.resolve(true))
    expect(result.stale).toEqual([
      { containerName: 'abc123', projectSlug: '', sessionId: '', zombie: false },
    ])
  })

  it('strips the leading slash from container names', async () => {
    const c = container({ name: 'yaac-proj-s1' })
    const isTmuxAlive = vi.fn().mockResolvedValue(true)
    await classifySessionContainers([c], now(), isTmuxAlive)
    expect(isTmuxAlive).toHaveBeenCalledWith('yaac-proj-s1')
  })

  it('honors an explicit graceMs override', async () => {
    const c = container({ state: 'exited', ageMs: 500 })
    const zeroGrace = await classifySessionContainers([c], now(), () => Promise.resolve(true), 0)
    expect(zeroGrace.stale).toHaveLength(1)
    const largeGrace = await classifySessionContainers([c], now(), () => Promise.resolve(true), 10_000)
    expect(largeGrace.stale).toEqual([])
  })
})

describe('resolveStartingGraceMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the default when YAAC_STARTING_GRACE_MS is unset', () => {
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '')
    expect(resolveStartingGraceMs()).toBe(STARTING_GRACE_MS)
  })

  it('returns the parsed env value when set', () => {
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '0')
    expect(resolveStartingGraceMs()).toBe(0)
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '2500')
    expect(resolveStartingGraceMs()).toBe(2500)
  })

  it('falls back to the default for unparseable or negative values', () => {
    vi.stubEnv('YAAC_STARTING_GRACE_MS', 'not-a-number')
    expect(resolveStartingGraceMs()).toBe(STARTING_GRACE_MS)
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '-5')
    expect(resolveStartingGraceMs()).toBe(STARTING_GRACE_MS)
  })
})
