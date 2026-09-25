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
  supportedPermissionModes,
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
    // A workspace stamped with a tool this build does not know still has to
    // render and be exec'd into, so the resolved value is always runnable.
    expect(normalizeTool('unknown')).toBe('claude')
  })
})

describe('PERMISSION_MODES', () => {
  // Every list of postures — the create form's dropdown, the CLI's choices —
  // reads as the hierarchy, most permissive first.
  it('runs most permissive first, and so does every tool\'s list', () => {
    expect(PERMISSION_MODES).toEqual(['bypass', 'auto', 'accept-edits', 'manual', 'plan', 'read-only'])
    for (const tool of AGENT_TOOLS) {
      for (const agentMode of ['tui', 'acp'] as const) {
        const modes = supportedPermissionModes(tool, agentMode)
        expect(modes, `${tool} ${agentMode}`).toEqual(PERMISSION_MODES.filter((m) => modes.includes(m)))
      }
    }
  })
})

describe('toolSupportsPermissionMode', () => {
  it('answers for the TUI by default, so every caller that predates modes is unchanged', () => {
    expect(toolSupportsPermissionMode('codex', 'read-only')).toBe(true)
    expect(toolSupportsPermissionMode('opencode', 'auto')).toBe(false)
    expect(toolSupportsPermissionMode('pi', 'bypass')).toBe(true)
    expect(toolSupportsPermissionMode('pi', 'manual')).toBe(false)
  })

  it('answers for the ADAPTER under acp, which offers fewer postures', () => {
    // The one that surprises: codex has a read-only sandbox, codex-acp does
    // not — it collapses codex's approval × sandbox grid into three modes, the
    // one it calls `read-only` being codex's default preset. Refusing is the
    // point; a create that quietly ran `read-only` as something weaker would
    // be handing back an unrestrained worktree.
    expect(toolSupportsPermissionMode('codex', 'read-only', 'tui')).toBe(true)
    expect(toolSupportsPermissionMode('codex', 'read-only', 'acp')).toBe(false)
    expect(toolSupportsPermissionMode('codex', 'manual', 'acp')).toBe(false)
    expect(toolSupportsPermissionMode('codex', 'auto', 'acp')).toBe(true)
    // opencode keeps all four: `plan` is one of its own agents, and the rest
    // ride the same permission config its TUI reads.
    expect(supportedPermissionModes('opencode', 'acp')).toEqual(SUPPORTED_PERMISSION_MODES.opencode)
    // claude's adapter names a mode for all five of its postures.
    expect(supportedPermissionModes('claude', 'acp')).toEqual(SUPPORTED_PERMISSION_MODES.claude)
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
  // With nothing that strict, the agent mode's strictest — never the
  // driver default, which in a container is bypass.
  it('lands a remembered posture the agent mode has nothing as strict as on its strictest', () => {
    expect(resolve({ tool: 'codex', agentMode: 'acp', remembered: { permissionMode: 'read-only' } }).permissionMode)
      .toBe('accept-edits')
    expect(resolve({ tool: 'pi', remembered: { permissionMode: 'plan' } }).permissionMode).toBe('bypass')
  })

  // A posture this build does not rank — one a newer build added, read back
  // with a bare cast — compares with nothing, so it is the strictest there is.
  it('lands a remembered posture this build does not rank on the strictest', () => {
    const unranked = 'dontAsk' as PermissionMode
    expect(resolve({ tool: 'codex', remembered: { permissionMode: unranked } }).permissionMode).toBe('read-only')
    expect(resolve({ tool: 'claude', remembered: { permissionMode: unranked } }).permissionMode).toBe('plan')
  })

  // One it still has something as strict as becomes that, never the default:
  // a restraint someone chose does not quietly loosen.
  it('lands a remembered posture the tool lacks on its nearest one no looser', () => {
    expect(resolve({ tool: 'codex', remembered: { permissionMode: 'plan' } }).permissionMode).toBe('read-only')
    expect(resolve({ tool: 'codex', remembered: { permissionMode: 'manual' } }).permissionMode).toBe('read-only')
    expect(resolve({ tool: 'claude', remembered: { permissionMode: 'read-only' } }).permissionMode).toBe('plan')
    expect(resolve({ tool: 'opencode', remembered: { permissionMode: 'auto' } }).permissionMode).toBe('accept-edits')
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

describe('AGENT_CLIS', () => {
  it('names the version the worktree image installs', () => {
    // yaac launches each posture as the CLI's own flags and reads the CLI's own
    // reports back as one, so the image must run the release those were
    // checked against — the same one a host install asks npm for.
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
