import { describe, it, expect, beforeEach, vi } from 'vitest'

// The config reader is the process boundary here: which chain a project
// runs is answered from disk, and this verb exists to resolve that before
// the runtime — which may not read config — is asked to rebuild anything.
vi.mock('#domain/projects/config', () => ({
  resolveProjectConfig: vi.fn(),
}))
// The pool is the other thing a rebuild invalidates. Mocked at the verb
// that owns it: what this module decides is only THAT the spares must go,
// and when relative to the rebuild.
vi.mock('#domain/worktrees/prewarm-reconcile', () => ({
  reapProjectSpares: vi.fn(),
}))

import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { resolveProjectConfig } from '#domain/projects/config'
import { reapProjectSpares } from '#domain/worktrees/prewarm-reconcile'
import { rebuildProjectImage } from '#domain/images/rebuild'

const mockResolveConfig = vi.mocked(resolveProjectConfig)
const mockReapSpares = vi.mocked(reapProjectSpares)
type RebuildVerb = (
  slug: string,
  opts: { nestedContainers: boolean; onLog?: (line: string) => void },
) => Promise<string>

function fakeRebuild(): ReturnType<typeof vi.fn<RebuildVerb>> {
  const mock = vi.fn<RebuildVerb>().mockResolvedValue('yaac-user-demo:abc123')
  installFakeWorktreeDriver({ rebuildImage: mock })
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveConfig.mockResolvedValue(null)
  mockReapSpares.mockResolvedValue(0)
})

describe('rebuildProjectImage', () => {
  // THE bug this verb exists to prevent: a nested project whose rebuild
  // resolved the default chain rebuilds base → tools → user, publishes its
  // tag, and reports success — while every one of that project's worktrees
  // runs the nestable chain's tag, which was never rebuilt at all.
  it('tells the runtime a nested project runs the nestable chain', async () => {
    const mockRebuild = fakeRebuild()
    mockResolveConfig.mockResolvedValue({ nestedContainers: true })

    await rebuildProjectImage('demo')

    expect(mockRebuild).toHaveBeenCalledExactlyOnceWith(
      'demo',
      expect.objectContaining({ nestedContainers: true }),
    )
    expect(mockResolveConfig).toHaveBeenCalledWith('demo')
  })

  // virtualCluster implies nestedContainers — the in-pod podman is a
  // vcluster worktree's only build engine. The config parser normalizes
  // that, and reading both keeps this agreeing with worktree create for a
  // config that never went through it.
  it('treats virtualCluster as nested', async () => {
    const mockRebuild = fakeRebuild()
    mockResolveConfig.mockResolvedValue({ virtualCluster: true })

    await rebuildProjectImage('demo')

    expect(mockRebuild.mock.calls[0][1]).toMatchObject({ nestedContainers: true })
  })

  it('rebuilds the plain chain for a project with no config', async () => {
    const mockRebuild = fakeRebuild()
    mockResolveConfig.mockResolvedValue(null)

    await expect(rebuildProjectImage('demo')).resolves.toBe('yaac-user-demo:abc123')

    expect(mockRebuild.mock.calls[0][1]).toMatchObject({ nestedContainers: false })
  })

  // A rebuild runs for minutes, so its narration is the response as far as
  // the CLI is concerned — this verb must not swallow it.
  it('passes the caller’s narration through to the runtime', async () => {
    const lines: string[] = []
    const mockRebuild = vi.fn<RebuildVerb>().mockImplementation((_slug, opts) => {
      opts.onLog?.('building yaac-tools:abc (no cache)')
      return Promise.resolve('yaac-tools:abc')
    })
    installFakeWorktreeDriver({ rebuildImage: mockRebuild })

    await rebuildProjectImage('demo', { onLog: (line) => lines.push(line) })

    expect(lines).toEqual(['building yaac-tools:abc (no cache)'])
  })

  // A spare is a fully-provisioned worktree whose image was resolved when it
  // was warmed, and nothing in the pool notices it has gone stale — so the
  // first create after a successful rebuild would claim a pre-rebuild spare
  // and hand back exactly the CLIs the rebuild replaced.
  it('drops the project’s prewarmed spares once the rebuild lands', async () => {
    const mockRebuild = fakeRebuild()

    await rebuildProjectImage('demo')

    expect(mockReapSpares).toHaveBeenCalledExactlyOnceWith('demo')
    // After, never before: the pool refills on the reconciler's next tick,
    // and a spare warmed while the rebuild was still running would carry the
    // old image just the same.
    expect(mockRebuild.mock.invocationCallOrder[0])
      .toBeLessThan(mockReapSpares.mock.invocationCallOrder[0])
  })

  it('says so when spares were dropped, and stays quiet when there were none', async () => {
    fakeRebuild()
    mockReapSpares.mockResolvedValue(1)
    const lines: string[] = []
    await rebuildProjectImage('demo', { onLog: (line) => lines.push(line) })
    expect(lines.join('\n')).toMatch(/Dropped 1 prewarmed session\b/)

    mockReapSpares.mockResolvedValue(0)
    const quiet: string[] = []
    await rebuildProjectImage('demo', { onLog: (line) => quiet.push(line) })
    expect(quiet).toEqual([])
  })

  // A failed rebuild changed nothing, so the spares it warmed are still
  // correct — reaping them would cost the user a pool for no reason.
  it('keeps the spares when the rebuild failed', async () => {
    installFakeWorktreeDriver({
      rebuildImage: () => Promise.reject(new Error('standalone Dockerfile.yaac')),
    })

    // The failure reaches the caller either way — a rebuild that built
    // nothing must not read as success.
    await expect(rebuildProjectImage('demo')).rejects.toThrow(/standalone/)
    expect(mockReapSpares).not.toHaveBeenCalled()
  })
})
