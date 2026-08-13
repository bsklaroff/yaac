import { describe, it, expect, beforeEach, vi } from 'vitest'

// The reader this verb injects is the process boundary here: what a
// project's config resolves to is answered from disk, and a retry must be
// able to hand the runtime that answer without one on disk.
vi.mock('#domain/projects/config', () => ({
  resolveProjectConfig: vi.fn(),
}))

import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { resolveProjectConfig } from '#domain/projects/config'
import { retryImageBuild } from '#domain/images/retry'
import type { YaacConfig } from '@yaac/shared/types'

const mockResolveConfig = vi.mocked(resolveProjectConfig)
type RetryVerb = (id: string, cfg: (slug: string) => Promise<YaacConfig | undefined>) => boolean

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveConfig.mockResolvedValue(null)
})

describe('retryImageBuild', () => {
  it('hands the runtime a reader for the owning project’s config', async () => {
    const mockRetry = vi.fn<RetryVerb>().mockReturnValue(true)
    installFakeWorktreeDriver({ retryImageBuild: mockRetry })
    mockResolveConfig.mockResolvedValue({ nestedContainers: true })

    expect(retryImageBuild('b1')).toBe(true)

    // The runtime cannot read config itself — a rebuild that defaulted it
    // would silently drop a nested project's nestable layer.
    const reader = mockRetry.mock.calls[0][1]
    await expect(reader('demo')).resolves.toEqual({ nestedContainers: true })
    expect(mockResolveConfig).toHaveBeenCalledWith('demo')
  })

  // "No config" is the ordinary case and reads as all-defaults. The store
  // says so with null; the contract's reader says so with undefined, and
  // the translation is this verb's.
  it('translates a project with no config to undefined', async () => {
    const mockRetry = vi.fn<RetryVerb>().mockReturnValue(true)
    installFakeWorktreeDriver({ retryImageBuild: mockRetry })
    mockResolveConfig.mockResolvedValue(null)

    retryImageBuild('b1')

    await expect(mockRetry.mock.calls[0][1]('demo')).resolves.toBeUndefined()
  })

  it('reports that there was nothing to retry', () => {
    installFakeWorktreeDriver({ retryImageBuild: () => false })

    expect(retryImageBuild('gone')).toBe(false)
  })
})
