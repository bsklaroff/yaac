import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  ACP_ADAPTERS,
  AGENT_CLIS,
  AGENT_TOOLS,
  defaultPermissionMode,
  normalizeTool,
  PERMISSION_MODES,
  resolveToolCreateDefaults,
  SUPPORTED_PERMISSION_MODES,
  toolSupportsPermissionMode,
  type PermissionMode,
} from '#types'

describe('normalizeTool', () => {
  it('returns claude when the raw value is undefined', () => {
    expect(normalizeTool(undefined)).toBe('claude')
  })

  it('returns claude when the raw value is claude', () => {
    expect(normalizeTool('claude')).toBe('claude')
  })

  it('returns codex when the raw value is codex', () => {
    expect(normalizeTool('codex')).toBe('codex')
  })

  it('returns opencode when the raw value is opencode', () => {
    expect(normalizeTool('opencode')).toBe('opencode')
  })

  it('returns pi when the raw value is pi', () => {
    expect(normalizeTool('pi')).toBe('pi')
  })

  it('returns claude for an empty string', () => {
    expect(normalizeTool('')).toBe('claude')
  })

  it('returns claude for unknown tool values', () => {
    // A workspace with a tool this build doesn't know must still render and
    // accept exec.
    expect(normalizeTool('unknown')).toBe('claude')
  })
})

describe('PERMISSION_MODES', () => {
  // Every posture list (form dropdown, CLI choices) is most permissive
  // first.
  it('runs most permissive first, and so does every tool\'s list', () => {
    expect(PERMISSION_MODES).toEqual(['bypass', 'auto', 'accept-edits', 'manual', 'plan', 'read-only'])
    for (const tool of AGENT_TOOLS) {
      const modes = SUPPORTED_PERMISSION_MODES[tool]
      expect(modes, tool).toEqual(PERMISSION_MODES.filter((m) => modes.includes(m)))
    }
  })
})

describe('toolSupportsPermissionMode', () => {
  it("answers from the tool's own list", () => {
    expect(toolSupportsPermissionMode('codex', 'read-only')).toBe(true)
    expect(toolSupportsPermissionMode('codex', 'manual')).toBe(false)
    expect(toolSupportsPermissionMode('opencode', 'auto')).toBe(false)
    expect(toolSupportsPermissionMode('pi', 'bypass')).toBe(true)
    expect(toolSupportsPermissionMode('pi', 'manual')).toBe(false)
  })

  it('never defaults a create into a posture the tool cannot take', () => {
    // `defaultPermissionMode` is used unchecked when a create names no
    // posture, so every entry must be one the tool has; otherwise an ACP
    // adapter would silently run its own default.
    for (const driver of ['k8s', 'containerless'] as const) {
      for (const tool of AGENT_TOOLS) {
        const fallback = defaultPermissionMode(driver, tool)
        expect(toolSupportsPermissionMode(tool, fallback), `${driver}/${tool}`).toBe(true)
      }
    }
  })
})

/**
 * Used by both the create form and the server, so the form shows what an
 * untouched create would run.
 */
describe('resolveToolCreateDefaults', () => {
  const resolve = (args: Partial<Parameters<typeof resolveToolCreateDefaults>[0]> = {}) =>
    resolveToolCreateDefaults({
      driver: 'k8s', tool: 'claude', remembered: undefined, defaultModel: 'fallback', ...args,
    })

  it('falls back per field when nothing is remembered', () => {
    expect(resolve()).toEqual({ model: 'fallback', permissionMode: 'bypass' })
    expect(resolve({ driver: 'containerless' }).permissionMode).toBe('accept-edits')
  })

  it('takes what is remembered where it still fits', () => {
    expect(resolve({ remembered: { model: 'claude-sonnet-5', permissionMode: 'plan' } }))
      .toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan' })
  })

  // A remembered posture is a preference, so it falls back rather than
  // being refused: to the strictest available, never the driver default
  // (bypass in a container).
  it('lands a remembered posture the agent has nothing as strict as on its strictest', () => {
    expect(resolve({ tool: 'pi', remembered: { permissionMode: 'plan' } }).permissionMode).toBe('bypass')
  })

  // A posture this build doesn't rank (added by a newer build) is treated
  // as the strictest.
  it('lands a remembered posture this build does not rank on the strictest', () => {
    const unranked = 'dontAsk' as PermissionMode
    expect(resolve({ tool: 'codex', remembered: { permissionMode: unranked } }).permissionMode).toBe('read-only')
    expect(resolve({ tool: 'claude', remembered: { permissionMode: unranked } }).permissionMode).toBe('plan')
  })

  // A chosen restriction never quietly loosens.
  it('lands a remembered posture the tool lacks on its nearest one no looser', () => {
    expect(resolve({ tool: 'codex', remembered: { permissionMode: 'plan' } }).permissionMode).toBe('read-only')
    expect(resolve({ tool: 'codex', remembered: { permissionMode: 'manual' } }).permissionMode).toBe('read-only')
    expect(resolve({ tool: 'claude', remembered: { permissionMode: 'read-only' } }).permissionMode).toBe('plan')
    expect(resolve({ tool: 'opencode', remembered: { permissionMode: 'auto' } }).permissionMode).toBe('accept-edits')
  })

  // A `provider/model` id for a provider other than the stored credential's
  // would hit a host the proxy swaps no key on.
  it('drops a remembered model for a provider the credential no longer names', () => {
    const remembered = { model: 'openrouter/moonshotai/kimi-k2.6' }
    expect(resolve({ tool: 'opencode', provider: 'openrouter', remembered }).model).toBe(remembered.model)
    expect(resolve({ tool: 'opencode', provider: 'anthropic', remembered }).model).toBe('fallback')
    // claude and codex ids carry no provider, and a typed one stands.
    expect(resolve({ remembered: { model: 'claude-next' } }).model).toBe('claude-next')
  })
})

describe('AGENT_CLIS', () => {
  it('names the version the workspace image installs', () => {
    // yaac's posture flags were verified against this release, so the image
    // must run the same one a host install gets from npm.
    const dockerfile = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../dockerfiles/Dockerfile.tools'),
      'utf8',
    )
    for (const tool of AGENT_TOOLS) {
      const { package: pkg, version } = AGENT_CLIS[tool]
      // claude goes through its own installer, which takes the version.
      const installed = tool === 'claude'
        ? /install\.sh \| bash -s (\S+)/.exec(dockerfile)?.[1]
        : new RegExp(`${pkg.replace(/[/@.]/g, '\\$&')}@(\\S+)`).exec(dockerfile)?.[1]
      expect(installed, `${tool}: ${pkg} is not pinned in Dockerfile.tools`).toBe(version)
    }
  })
})

describe('ACP_ADAPTERS', () => {
  it('names the version the workspace image installs', () => {
    // `verified` is the version yaac's session-mode mapping was checked
    // against. An adapter that drops a mode fails silently (the session runs
    // in its default), so on an image bump re-verify the adapter's `modeIds`
    // (runtime/agents/acp-adapters.ts) against `SUPPORTED_PERMISSION_MODES`,
    // then move `verified`.
    const dockerfile = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../dockerfiles/Dockerfile.tools'),
      'utf8',
    )
    for (const tool of AGENT_TOOLS) {
      const { package: pkg, verified } = ACP_ADAPTERS[tool]
      const installed = new RegExp(`${pkg.replace(/[/@.]/g, '\\$&')}@(\\S+)`).exec(dockerfile)?.[1]
      expect(installed, `${tool}: ${pkg} is not pinned in Dockerfile.tools`).toBe(verified)
    }
  })
})
