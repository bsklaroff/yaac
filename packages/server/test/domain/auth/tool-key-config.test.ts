import { describe, it, expect } from 'vitest'
import { toolKeyProviders } from '#domain/auth'
import type { CustomEndpoint } from '@yaac/shared/tool-providers'

describe('toolKeyProviders', () => {
  it('gives each signed-in api-key tool its provider row, with its custom endpoint', () => {
    const endpoint: CustomEndpoint = { id: 'e', name: 'box', baseUrl: 'https://box/v1', models: [{ id: 'llama' }] }
    const providers = toolKeyProviders({
      opencode: { tool: 'opencode', kind: 'api-key', apiKey: 'k', savedAt: 's', opencodeProvider: 'openrouter' },
      pi: { tool: 'pi', kind: 'api-key', apiKey: '', savedAt: 's', piProvider: 'custom', endpoint },
      omp: null,
    })
    expect(providers.opencode).toMatchObject({ id: 'openrouter', apiHost: 'openrouter.ai', endpoint: undefined })
    expect(providers.pi).toMatchObject({ id: 'custom', label: 'Custom (OpenAI-compatible)', endpoint })
    expect(providers).not.toHaveProperty('omp')
  })
})
