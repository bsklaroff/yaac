import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  installSecurityContext,
  processIdentity,
  runtimeClassSpec,
  sentryTmpfsAnnotations,
} from '#drivers/k8s/substrate'

describe('sentryTmpfsAnnotations', () => {
  it('keys the sentry tmpfs hints on the volume name and caps it at the size (builder pods use 16Gi)', () => {
    expect(sentryTmpfsAnnotations('podman-graphroot', 16 * 1024 ** 3)).toEqual({
      'dev.gvisor.spec.mount.podman-graphroot.type': 'bind',
      'dev.gvisor.spec.mount.podman-graphroot.share': 'container',
      'dev.gvisor.spec.mount.podman-graphroot.options': `rw,size=${16 * 1024 ** 3}`,
    })
  })
})

describe('installSecurityContext', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stamps the identity it is handed, and joins group 0 for the image', () => {
    // The uid is chosen per install. Group 0 lets one image run at any uid
    // (docs/arbitrary-uid-images.md).
    expect(installSecurityContext({ uid: 1000, gid: 1000 })).toEqual({
      runAsUser: 1000,
      runAsGroup: 1000,
      supplementalGroups: [0],
    })
  })

  it('defaults to this process\'s identity, which inside the server pod is the install\'s', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(501)
    vi.spyOn(process, 'getgid').mockReturnValue(20)
    expect(installSecurityContext()).toEqual({
      runAsUser: 501,
      runAsGroup: 20,
      supplementalGroups: [0],
    })
  })

})

describe('processIdentity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads this process\'s uid and gid', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000)
    vi.spyOn(process, 'getgid').mockReturnValue(1000)
    expect(processIdentity()).toEqual({ uid: 1000, gid: 1000 })
  })

  it('refuses to invent a uid when the platform has none', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(undefined as unknown as number)
    expect(() => processIdentity()).toThrow(/POSIX/)
  })
})

describe('runtimeClassSpec', () => {
  it('stamps gvisor by default and gvisor-nested for nested pods', () => {
    expect(runtimeClassSpec({})).toEqual({ runtimeClassName: RUNTIME_CLASS_GVISOR })
    expect(runtimeClassSpec({ nested: true }))
      .toEqual({ runtimeClassName: RUNTIME_CLASS_GVISOR_NESTED })
  })
})
