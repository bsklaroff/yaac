import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#lib/apiClient', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}))

import { api } from '#lib/apiClient'
import { dismissImageBuild, getImageBuildLog } from '#lib/imageBuildsApi'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('image builds api calls', () => {
  it('getImageBuildLog GETs the build log route', async () => {
    await getImageBuildLog('build-7')
    expect(api.get).toHaveBeenCalledWith('/image/builds/build-7/log')
  })

  it('dismissImageBuild DELETEs the build route', async () => {
    await dismissImageBuild('build-7')
    expect(api.del).toHaveBeenCalledWith('/image/builds/build-7')
  })
})
