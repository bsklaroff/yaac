import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from '@/frontend/lib/apiClient'
import {
  getProjectConfig,
  saveProjectConfig,
  getProjectDockerfile,
  saveProjectDockerfile,
} from '@/frontend/lib/projectApi'
import { getUserDockerfile, saveUserDockerfile } from '@/frontend/lib/settingsApi'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('project config / dockerfile api', () => {
  it('getProjectConfig unwraps { config }', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ config: { envPassthrough: ['X'] } })
    expect(await getProjectConfig('my proj')).toEqual({ envPassthrough: ['X'] })
    expect(get).toHaveBeenCalledWith('/project/my%20proj/config')
  })

  it('saveProjectConfig PUTs { config } and unwraps the result', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ config: { envPassthrough: ['Y'] } })
    expect(await saveProjectConfig('demo', { envPassthrough: ['Y'] })).toEqual({ envPassthrough: ['Y'] })
    expect(put).toHaveBeenCalledWith('/project/demo/config', { config: { envPassthrough: ['Y'] } })
  })

  it('getProjectDockerfile unwraps { content }', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ content: 'FROM x\n' })
    expect(await getProjectDockerfile('demo')).toBe('FROM x\n')
  })

  it('saveProjectDockerfile PUTs { content }', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ content: 'FROM x\n' })
    await saveProjectDockerfile('demo', 'FROM x\n')
    expect(put).toHaveBeenCalledWith('/project/demo/dockerfile', { content: 'FROM x\n' })
  })
})

describe('user dockerfile api', () => {
  it('getUserDockerfile unwraps { content }', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ content: 'ARG BASE_IMAGE\n' })
    expect(await getUserDockerfile()).toBe('ARG BASE_IMAGE\n')
  })

  it('saveUserDockerfile PUTs { content } to /config/user-dockerfile', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ content: '' })
    await saveUserDockerfile('')
    expect(put).toHaveBeenCalledWith('/config/user-dockerfile', { content: '' })
  })
})
