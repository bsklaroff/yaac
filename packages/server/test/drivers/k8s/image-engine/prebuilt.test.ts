import { describe, it, expect, afterEach, vi } from 'vitest'
import { missingPrebuiltImage } from '#drivers/k8s/image-engine'

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
    // An e2e run's images come from test/global-setup.ts, so sending it to
    // `cluster install` would send it to the wrong prebuild.
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    const err = missingPrebuiltImage('netd', 'yaac-test-netd:abc123')
    expect(err.message).toContain('Restart the test run')
    expect(err.message).not.toContain('yaac cluster install')
  })
})
