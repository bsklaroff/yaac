import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ensureRootfulPodmanHost } from '#drivers/k8s/install'

const realPlatform = process.platform
const realHost = process.env.CONTAINER_HOST

/** The rootful setup depends on platform, so tests set it explicitly. */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  setPlatform(realPlatform)
  if (realHost === undefined) delete process.env.CONTAINER_HOST
  else process.env.CONTAINER_HOST = realHost
})

describe('ensureRootfulPodmanHost', () => {
  beforeEach(() => { delete process.env.CONTAINER_HOST })

  it('points CONTAINER_HOST at the rootful socket on linux', () => {
    setPlatform('linux')
    ensureRootfulPodmanHost()
    expect(process.env.CONTAINER_HOST).toBe('unix:///run/podman/podman.sock')
  })

  it('honours a CONTAINER_HOST the caller already set', () => {
    setPlatform('linux')
    process.env.CONTAINER_HOST = 'unix:///custom.sock'
    ensureRootfulPodmanHost()
    expect(process.env.CONTAINER_HOST).toBe('unix:///custom.sock')
  })

  it('is a no-op on darwin, where podman machine owns the connection', () => {
    setPlatform('darwin')
    ensureRootfulPodmanHost()
    expect(process.env.CONTAINER_HOST).toBeUndefined()
  })
})
