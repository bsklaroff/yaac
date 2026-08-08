import { describe, it, expect } from 'vitest'
import { acpAdapterFor } from '#features/agents/acp-driver'
import { ACP_TOOLS, AGENT_TOOLS } from '@yaac/shared/types'

/**
 * The driver itself is exercised through `agentDriver` (drivers.test.ts); this
 * covers the one question it answers on its own — which tools can run in ACP
 * mode at all.
 */
describe('acpAdapterFor', () => {
  it('names the in-image adapter binary for a tool that has one', () => {
    expect(acpAdapterFor('claude')).toBe('claude-agent-acp')
  })

  it('has no adapter for the tools that ship none, so create can reject early', () => {
    for (const tool of AGENT_TOOLS.filter((t) => !ACP_TOOLS.includes(t))) {
      expect(acpAdapterFor(tool)).toBeUndefined()
    }
  })

  it('agrees with the shared ACP_TOOLS list the webapp offers a chat pane for', () => {
    // Two lists, one truth: a tool the webapp offers but the image cannot run
    // would fail at create time instead of being hidden from the menu.
    const withAdapter = AGENT_TOOLS.filter((t) => acpAdapterFor(t) !== undefined)
    expect(withAdapter).toEqual([...ACP_TOOLS])
  })
})
