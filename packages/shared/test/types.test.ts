import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  ACP_ADAPTERS,
  AGENT_TOOLS,
  defaultPermissionMode,
  normalizeTool,
  PERMISSION_MODES,
  resolveToolCreateDefaults,
  SUPPORTED_PERMISSION_MODES,
  supportedPermissionModes,
  toolSupportsPermissionMode,
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
    // A workspace stamped with a tool this build does not know still has to
    // render and be exec'd into, so the resolved value is always runnable.
    expect(normalizeTool('unknown')).toBe('claude')
  })
})

describe('toolSupportsPermissionMode', () => {
  it('answers for the TUI by default, so every caller that predates modes is unchanged', () => {
    expect(toolSupportsPermissionMode('codex', 'plan')).toBe(true)
    expect(toolSupportsPermissionMode('opencode', 'auto')).toBe(false)
    expect(toolSupportsPermissionMode('pi', 'bypass')).toBe(true)
    expect(toolSupportsPermissionMode('pi', 'manual')).toBe(false)
  })

  it('answers for the ADAPTER under acp, which offers fewer postures', () => {
    // The one that surprises: codex has plan mode, codex-acp does not — it
    // collapses codex's approval × sandbox grid into three modes. Refusing is
    // the point; a create that quietly ran `plan` as something weaker would be
    // handing back an unrestrained worktree.
    expect(toolSupportsPermissionMode('codex', 'plan', 'tui')).toBe(true)
    expect(toolSupportsPermissionMode('codex', 'plan', 'acp')).toBe(false)
    expect(toolSupportsPermissionMode('codex', 'manual', 'acp')).toBe(false)
    expect(toolSupportsPermissionMode('codex', 'auto', 'acp')).toBe(true)
    // opencode keeps all four: `plan` is one of its own agents, and the rest
    // ride the same permission config its TUI reads.
    expect(supportedPermissionModes('opencode', 'acp')).toEqual(SUPPORTED_PERMISSION_MODES.opencode)
    // claude's adapter names a mode for all five.
    expect(supportedPermissionModes('claude', 'acp')).toEqual(PERMISSION_MODES)
  })

  it('never offers a posture over acp that the tool itself does not have', () => {
    // acp is a different way to drive the same tool, never a way to reach a
    // restraint the tool has no notion of.
    for (const tool of AGENT_TOOLS) {
      for (const mode of supportedPermissionModes(tool, 'acp')) {
        expect(toolSupportsPermissionMode(tool, mode, 'tui'), `${tool}/${mode}`).toBe(true)
      }
    }
  })

  it('never defaults a create into a posture its adapter cannot take', () => {
    // A create that names no posture takes `defaultPermissionMode`, which is
    // not checked against either column — it is the answer of last resort. So
    // every cell of it has to be a posture the adapter actually has, or a
    // containerless create for that tool would launch into the adapter's own
    // default with nothing refusing it and nothing saying so.
    for (const driver of ['k8s', 'containerless'] as const) {
      for (const tool of AGENT_TOOLS) {
        const fallback = defaultPermissionMode(driver, tool)
        expect(toolSupportsPermissionMode(tool, fallback, 'acp'), `${driver}/${tool}`).toBe(true)
        expect(toolSupportsPermissionMode(tool, fallback, 'tui'), `${driver}/${tool}`).toBe(true)
      }
    }
  })
})

/**
 * The one resolution both ends make — the create form to show a field, the
 * server to launch it — so the form always shows what an untouched create
 * would run.
 */
describe('resolveToolCreateDefaults', () => {
  const resolve = (args: Partial<Parameters<typeof resolveToolCreateDefaults>[0]> = {}) =>
    resolveToolCreateDefaults({
      driver: 'k8s', tool: 'claude', agentMode: 'tui', remembered: undefined, defaultModel: 'fallback', ...args,
    })

  it('falls back per field when nothing is remembered', () => {
    expect(resolve()).toEqual({ model: 'fallback', permissionMode: 'bypass' })
    expect(resolve({ driver: 'containerless' }).permissionMode).toBe('accept-edits')
  })

  it('takes what is remembered where it still fits', () => {
    expect(resolve({ remembered: { model: 'claude-sonnet-5', permissionMode: 'plan' } }))
      .toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan' })
  })

  // Recorded under the terminal, asked for in chat: codex's adapter has no
  // plan mode, so the remembered posture falls through rather than being
  // refused — it was a preference, not a demand.
  it('drops a remembered posture the agent mode does not offer', () => {
    expect(resolve({ tool: 'codex', agentMode: 'acp', remembered: { permissionMode: 'plan' } }).permissionMode)
      .toBe('bypass')
  })

  // A `provider/model` id names the vendor its key authenticates against; one
  // for a provider the stored credential no longer names would send the
  // request to a host the proxy swaps no key on.
  it('drops a remembered model for a provider the credential no longer names', () => {
    const remembered = { model: 'openrouter/moonshotai/kimi-k2.6' }
    expect(resolve({ tool: 'opencode', provider: 'openrouter', remembered }).model).toBe(remembered.model)
    expect(resolve({ tool: 'opencode', provider: 'anthropic', remembered }).model).toBe('fallback')
    // claude and codex ids carry no provider, and a typed one stands.
    expect(resolve({ remembered: { model: 'claude-next' } }).model).toBe('claude-next')
  })
})

describe('ACP_ADAPTERS', () => {
  it('names the version the worktree image installs', () => {
    // `verified` is what yaac's description of each adapter was checked
    // against — above all the session modes it advertises, which are read as
    // permission postures. An adapter that stops advertising one does not
    // fail; the session silently runs in its default. So nothing but this
    // catches an image bump that moved the vocabulary out from under
    // `ACP_SUPPORTED_PERMISSION_MODES` and the driver's mode ids: re-verify
    // against the new version, then move `verified` here.
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
