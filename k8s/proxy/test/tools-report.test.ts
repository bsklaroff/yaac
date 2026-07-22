import { describe, it, expect } from 'vitest'
import {
  buildToolsReport,
  formatToolsReport,
  modelsForTool,
  type AgentTool,
  type ToolCredsView,
} from 'yaac-proxy-sidecar/tools-report'
import { MODELS_BY_PROVIDER, PI_MODELS_BY_PROVIDER } from 'yaac-proxy-sidecar/tool-providers.generated'

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

describe('baked model catalogs', () => {
  it('carries non-empty model lists for the fixed claude/codex providers', () => {
    expect(MODELS_BY_PROVIDER['anthropic']?.length).toBeGreaterThan(0)
    expect(MODELS_BY_PROVIDER['openai']?.length).toBeGreaterThan(0)
  })

  it('excludes non-agent (non-tool-calling) models like embeddings', () => {
    // The generator keeps only tool_call models, so embedding/image ids that an
    // agent can't run must not appear (the review flagged text-embedding-3-large).
    expect(MODELS_BY_PROVIDER['openai']).not.toContain('text-embedding-3-large')
    expect(MODELS_BY_PROVIDER['openai']?.some((m) => m.startsWith('text-embedding'))).toBe(false)
    // codex-family agent models are still present.
    expect(MODELS_BY_PROVIDER['openai']).toContain('gpt-5-codex')
  })

  it('has a pi-registry catalog distinct from models.dev', () => {
    expect(PI_MODELS_BY_PROVIDER['anthropic']?.length).toBeGreaterThan(0)
  })
})

describe('modelsForTool', () => {
  it('maps claude → anthropic and codex → openai catalogs (bare ids)', () => {
    expect(modelsForTool('claude', undefined)).toEqual(MODELS_BY_PROVIDER['anthropic'])
    expect(modelsForTool('codex', undefined)).toEqual(MODELS_BY_PROVIDER['openai'])
  })

  it('prefixes opencode models with the configured provider (provider/model)', () => {
    const oc = modelsForTool('opencode', 'anthropic')
    expect(oc.length).toBeGreaterThan(0)
    expect(oc.every((m) => m.startsWith('anthropic/'))).toBe(true)
    expect(oc).toEqual((MODELS_BY_PROVIDER['anthropic'] ?? []).map((m) => `anthropic/${m}`))
    expect(modelsForTool('opencode', undefined)).toEqual([])
  })

  it('prefixes pi models and sources them from pi\'s own registry', () => {
    const pi = modelsForTool('pi', 'anthropic')
    expect(pi.length).toBeGreaterThan(0)
    expect(pi.every((m) => m.startsWith('anthropic/'))).toBe(true)
    expect(pi).toEqual((PI_MODELS_BY_PROVIDER['anthropic'] ?? []).map((m) => `anthropic/${m}`))
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

  it('reports the codex host by credential kind (OAuth → chatgpt.com)', () => {
    const oauth = buildToolsReport({ currentTool: 'codex', includeModels: false, creds: creds({ codex: { authed: true, kind: 'oauth' } }) })
    expect(oauth.tools.find((t) => t.tool === 'codex')?.apiHost).toBe('chatgpt.com')
    const apiKey = buildToolsReport({ currentTool: 'codex', includeModels: false, creds: creds({ codex: { authed: true, kind: 'api-key' } }) })
    expect(apiKey.tools.find((t) => t.tool === 'codex')?.apiHost).toBe('api.openai.com')
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
