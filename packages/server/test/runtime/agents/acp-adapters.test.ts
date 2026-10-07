import { describe, it, expect } from 'vitest'
import { acpLaunchModel } from '#runtime/agents'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'

describe('acpLaunchModel', () => {
  it('names the requested model, or nothing, for tools that take no default', () => {
    expect(acpLaunchModel({ tool: 'opencode', model: 'opencode/big-pickle' })).toBe('opencode/big-pickle')
    expect(acpLaunchModel({ tool: 'opencode' })).toBeUndefined()
  })

  // pi's provider decides which key the proxy swaps, so with no model it
  // still names that provider's default rather than pi's own setting.
  it("falls back to the pi provider's default model", () => {
    expect(acpLaunchModel({ tool: 'pi', model: 'openrouter/moonshotai/kimi-k2.6' })).toBe('openrouter/moonshotai/kimi-k2.6')
    expect(acpLaunchModel({ tool: 'pi' })).toBe(piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel)
  })
})
