import { describe, it, expect, beforeEach, vi } from 'vitest'

// The config reader is the process boundary here: which chain a project
// runs is answered from disk, and this verb exists to resolve that before
// the runtime — which may not read config — is asked to rebuild anything.
vi.mock('#domain/projects/config', () => ({
  resolveProjectConfig: vi.fn(),
}))

import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { resolveProjectConfig } from '#domain/projects/config'
import { rebuildProjectImage } from '#domain/images/rebuild'

const mockResolveConfig = vi.mocked(resolveProjectConfig)
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

  it('surfaces a rebuild that failed', async () => {
    installFakeWorktreeDriver({
      rebuildImage: () => Promise.reject(new Error('standalone Dockerfile.yaac')),
    })

    await expect(rebuildProjectImage('demo')).rejects.toThrow(/standalone/)
  })
})
