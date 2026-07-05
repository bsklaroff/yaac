import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/frontend/lib/apiClient', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}))

import { api } from '@/frontend/lib/apiClient'
import {
  cancelToolInstall, cancelToolLogin, clearToolAuth, getToolInstall, getToolLogin,
  sendToolLoginInput, setToolApiKey, startToolInstall, startToolLogin,
} from '@/frontend/lib/settingsApi'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tool sign-in api calls', () => {
  it('setToolApiKey PUTs an api-key payload to the tool route', async () => {
    await setToolApiKey('codex', 'sk-openai-x')
    expect(api.put).toHaveBeenCalledWith('/auth/codex', { kind: 'api-key', apiKey: 'sk-openai-x' })
  })

  it('setToolApiKey carries the opencode provider when given', async () => {
    await setToolApiKey('opencode', 'nw-key', 'neuralwatt')
    expect(api.put).toHaveBeenCalledWith(
      '/auth/opencode',
      { kind: 'api-key', apiKey: 'nw-key', provider: 'neuralwatt' },
    )
  })

  it('clearToolAuth POSTs the tool as the clear service', async () => {
    await clearToolAuth('opencode')
    expect(api.post).toHaveBeenCalledWith('/auth/clear', { service: 'opencode' })
  })
})

describe('web sign-in flow api calls', () => {
  it('startToolLogin POSTs to the tool login route', async () => {
    await startToolLogin('claude')
    expect(api.post).toHaveBeenCalledWith('/auth/claude/login/start')
  })

  it('getToolLogin polls the session route', async () => {
    await getToolLogin('id-1')
    expect(api.get).toHaveBeenCalledWith('/auth/login/id-1')
  })

  it('sendToolLoginInput POSTs the stdin line', async () => {
    await sendToolLoginInput('id-1', 'code#state')
    expect(api.post).toHaveBeenCalledWith('/auth/login/id-1/input', { text: 'code#state' })
  })

  it('cancelToolLogin POSTs the cancel route', async () => {
    await cancelToolLogin('id-1')
    expect(api.post).toHaveBeenCalledWith('/auth/login/id-1/cancel')
  })
})

describe('web install flow api calls', () => {
  it('startToolInstall POSTs to the tool install route', async () => {
    await startToolInstall('codex')
    expect(api.post).toHaveBeenCalledWith('/auth/codex/install/start')
  })

  it('getToolInstall polls the session route', async () => {
    await getToolInstall('id-2')
    expect(api.get).toHaveBeenCalledWith('/auth/install/id-2')
  })

  it('cancelToolInstall POSTs the cancel route', async () => {
    await cancelToolInstall('id-2')
    expect(api.post).toHaveBeenCalledWith('/auth/install/id-2/cancel')
  })
})
