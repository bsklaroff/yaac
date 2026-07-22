import { describe, it, expect } from 'vitest'
import {
  buildToolsReport,
  formatToolsReport,
  modelsForTool,
  type AgentTool,
  type ToolCredsView,
} from 'yaac-proxy-sidecar/tools-report'
import { MODELS_BY_PROVIDER } from 'yaac-proxy-sidecar/tool-providers.generated'

/** All-unauthed baseline; individual tests flip in the tools they exercise. */
function creds(over: Partial<Record<AgentTool, ToolCredsView>> = {}): Record<AgentTool, ToolCredsView> {
  return {
    claude: { authed: false },
    codex: { authed: false },
    opencode: { authed: false },
    pi: { authed: false },
    ...over,
  }
}

describe('MODELS_BY_PROVIDER (baked catalog)', () => {
  it('carries non-empty model lists for the fixed claude/codex providers', () => {
    expect(MODELS_BY_PROVIDER['anthropic']?.length).toBeGreaterThan(0)
    expect(MODELS_BY_PROVIDER['openai']?.length).toBeGreaterThan(0)
  })
})

describe('modelsForTool', () => {
  it('maps claude → anthropic and codex → openai catalogs', () => {
    expect(modelsForTool('claude', undefined)).toEqual(MODELS_BY_PROVIDER['anthropic'])
    expect(modelsForTool('codex', undefined)).toEqual(MODELS_BY_PROVIDER['openai'])
  })

  it('uses the configured provider for opencode', () => {
    expect(modelsForTool('opencode', 'anthropic')).toEqual(MODELS_BY_PROVIDER['anthropic'])
    expect(modelsForTool('opencode', undefined)).toEqual([])
  })

  it('prefixes pi models with the provider (provider/model form)', () => {
    const pi = modelsForTool('pi', 'anthropic')
    expect(pi.length).toBeGreaterThan(0)
    expect(pi.every((m) => m.startsWith('anthropic/'))).toBe(true)
  })

  it('returns [] for an unknown provider', () => {
    expect(modelsForTool('opencode', 'no-such-provider')).toEqual([])
  })
})

describe('buildToolsReport', () => {
  it('reports authed flags, current tool, provider, and host', () => {
    const report = buildToolsReport({
      currentTool: 'claude',
      includeModels: false,
      creds: creds({
        claude: { authed: true, kind: 'oauth' },
        opencode: { authed: true, kind: 'api-key', provider: 'anthropic' },
      }),
    })
    expect(report.currentTool).toBe('claude')
    const byTool = Object.fromEntries(report.tools.map((t) => [t.tool, t]))
    expect(byTool.claude).toMatchObject({ authed: true, current: true, kind: 'oauth', apiHost: 'api.anthropic.com' })
    expect(byTool.opencode).toMatchObject({ authed: true, current: false, provider: 'anthropic', apiHost: 'api.anthropic.com' })
    expect(byTool.codex.authed).toBe(false)
    expect(byTool.pi.authed).toBe(false)
  })

  it('omits models unless includeModels is set', () => {
    const off = buildToolsReport({ currentTool: null, includeModels: false, creds: creds({ claude: { authed: true, kind: 'api-key' } }) })
    expect(off.tools.find((t) => t.tool === 'claude')?.models).toBeUndefined()
    const on = buildToolsReport({ currentTool: null, includeModels: true, creds: creds({ claude: { authed: true, kind: 'api-key' } }) })
    expect(on.tools.find((t) => t.tool === 'claude')?.models?.length).toBeGreaterThan(0)
  })

  it('attaches a pi default model for the configured provider', () => {
    const report = buildToolsReport({ currentTool: 'pi', includeModels: false, creds: creds({ pi: { authed: true, kind: 'api-key', provider: 'anthropic' } }) })
    expect(report.tools.find((t) => t.tool === 'pi')?.defaultModel).toBe('anthropic/claude-opus-4-8')
  })
})

describe('formatToolsReport', () => {
  it('renders authed tools with models and unconfigured tools as "not configured"', () => {
    const text = formatToolsReport(buildToolsReport({
      currentTool: 'claude',
      includeModels: true,
      creds: creds({ claude: { authed: true, kind: 'oauth' } }),
    }))
    expect(text).toContain('current session tool: claude')
    expect(text).toContain('claude')
    expect(text).toContain('claude-opus-4-8')
    expect(text).toContain('codex')
    expect(text).toContain('not configured')
    expect(text).toContain('yaac-spawn --tool')
  })
})
