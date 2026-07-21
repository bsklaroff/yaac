import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#features/images/image-builder', () => ({
  buildImage: vi.fn(),
}))

vi.mock('#platform/container/runtime', () => ({
  imageExists: vi.fn(),
  removeImage: vi.fn(),
}))

vi.mock('#features/cluster/registry', () => ({
  registryHasTag: vi.fn(),
}))

vi.mock('#features/images/builder-pod', () => ({
  BuilderPodLease: class {},
  buildLayerInPod: vi.fn(),
}))

import {
  engineKindForLayer,
  engineForLayer,
  isTrustedLayer,
  hostPodmanEngine,
  clusterPodEngine,
  TRUSTED_PARENT_COMPRESSION,
} from '#features/images/build-engine'
import { buildImage, type ImageLayer } from '#features/images/image-builder'
import { imageExists, removeImage } from '#platform/container/runtime'
import { registryHasTag } from '#features/cluster/registry'
import { buildLayerInPod } from '#features/images/builder-pod'
import type { ImageLayerName } from '@yaac/shared/types'

// The whitelist: ONLY these yaac-shipped names build on host podman.
// Everything else — including any future layer name — is sandboxed by
// default.
const TRUSTED: ImageLayerName[] = ['base', 'tools', 'nestable']
const UNTRUSTED: ImageLayerName[] = ['project', 'user']

function layer(name: ImageLayerName): ImageLayer {
  return {
    tag: 't:1',
    name,
    dockerfile: '/ctx/Dockerfile',
    context: '/ctx',
    buildArgs: { BASE_IMAGE: 'p:1' },
    contentHash: 'h',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isTrustedLayer', () => {
  it.each(TRUSTED)('%s is trusted (yaac-shipped Dockerfile)', (name) => {
    expect(isTrustedLayer(name)).toBe(true)
  })

  it.each(UNTRUSTED)('%s is not trusted', (name) => {
    expect(isTrustedLayer(name)).toBe(false)
  })
})

describe('engineKindForLayer', () => {
  it.each(TRUSTED)('%s builds on host podman', (name) => {
    expect(engineKindForLayer(name)).toBe('host-podman')
  })

  it.each(UNTRUSTED)('%s builds in a cluster pod (always — no opt-out)', (name) => {
    expect(engineKindForLayer(name)).toBe('cluster-pod')
  })

  it('sandboxes any non-whitelisted layer name by default', () => {
    // Whitelist semantics: a name the routing has never heard of must NOT
    // fall through to the host engine.
    expect(engineKindForLayer('some-future-layer' as ImageLayerName)).toBe('cluster-pod')
  })

  it.each(UNTRUSTED)('%s stays on host podman in a nested install', (name) => {
    vi.stubEnv('YAAC_NESTED', '1')
    expect(engineKindForLayer(name)).toBe('host-podman')
  })
})

describe('engineForLayer', () => {
  it('returns the host engine for trusted layers', () => {
    expect(engineForLayer('tools')).toBe(hostPodmanEngine)
  })

  it('returns the cluster-pod engine for untrusted layers', () => {
    expect(engineForLayer('project')).toBe(clusterPodEngine)
  })
})

describe('hostPodmanEngine', () => {
  it('build delegates to buildImage with the layer fields', async () => {
    const l = layer('base')
    const onLog = vi.fn()
    await hostPodmanEngine.build(l, { projectSlug: 'p', noCache: true, onLog })
    expect(buildImage).toHaveBeenCalledWith(
      l.tag, l.dockerfile, l.context, l.buildArgs, { noCache: true, onLog },
    )
  })

  it('imageExists consults the host store', async () => {
    vi.mocked(imageExists).mockResolvedValue(true)
    expect(await hostPodmanEngine.imageExists('t:1')).toBe(true)
    expect(imageExists).toHaveBeenCalledWith('t:1')
  })

  it('remove removes the host image', async () => {
    await hostPodmanEngine.remove('t:1')
    expect(removeImage).toHaveBeenCalledWith('t:1')
  })
})

describe('clusterPodEngine', () => {
  it('build delegates to buildLayerInPod', async () => {
    const l = layer('project')
    const ctx = { projectSlug: 'p' }
    await clusterPodEngine.build(l, ctx)
    expect(buildLayerInPod).toHaveBeenCalledWith(l, ctx)
  })

  it('imageExists consults the registry (host store never sees these tags)', async () => {
    vi.mocked(registryHasTag).mockResolvedValue(true)
    expect(await clusterPodEngine.imageExists('t:1')).toBe(true)
    expect(registryHasTag).toHaveBeenCalledWith('t:1')
    expect(imageExists).not.toHaveBeenCalled()
  })

  it('remove is a no-op', async () => {
    await clusterPodEngine.remove('t:1')
    expect(removeImage).not.toHaveBeenCalled()
  })
})

describe('TRUSTED_PARENT_COMPRESSION', () => {
  it('is zstd (validated for builder-pod and node containerd pulls)', () => {
    expect(TRUSTED_PARENT_COMPRESSION).toBe('zstd')
  })
})
