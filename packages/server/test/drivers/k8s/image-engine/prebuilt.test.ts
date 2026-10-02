import { describe, it, expect, afterEach, vi } from 'vitest'
import type * as registryModule from '#drivers/k8s/container/registry'

// The registry is the process boundary.
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryHasTag: vi.fn(),
}))

import { missingPrebuiltImage, prebuiltRef } from '#drivers/k8s/image-engine'
import { registryHasTag, registryRef } from '#drivers/k8s/container/registry'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('missingPrebuiltImage', () => {
  it('names the command that produces the image', () => {
    const err = missingPrebuiltImage('netd', 'yaac-netd:abc123')
    expect(err.message).toContain('netd image yaac-netd:abc123 is missing')
    expect(err.message).toContain('yaac cluster install')
  })

  it('points a test run at its own prebuild instead', () => {
    // An e2e run's images come from test/global-setup.ts, not
    // `cluster install`.
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    const err = missingPrebuiltImage('netd', 'yaac-test-netd:abc123')
    expect(err.message).toContain('Restart the test run')
    expect(err.message).not.toContain('yaac cluster install')
  })
})

describe('prebuiltRef', () => {
  it('answers the in-cluster ref of a tag the registry holds, and refuses a missing one', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    await expect(prebuiltRef('netd', 'yaac-netd:abc123')).resolves.toBe(registryRef('yaac-netd:abc123'))

    // Never a build: a missing shipped image means a missing install.
    vi.mocked(registryHasTag).mockResolvedValue(false)
    await expect(prebuiltRef('netd', 'yaac-netd:abc123')).rejects.toThrow(/netd image yaac-netd:abc123 is missing/)
  })
})
