import { describe, it, expect } from 'vitest'
import { AGENT_INSTALL, ACP_ADAPTER_INSTALL, installCommandFor } from '#tool-install'
import { AGENT_TOOLS } from '#types'

describe('installCommandFor', () => {
  it('answers for every agent tool and every adapter binary', () => {
    // A tool with no entry would refuse a create saying only what is wrong,
    // which is barely better than the spawn failure this replaced.
    for (const tool of AGENT_TOOLS) expect(installCommandFor(tool)).toBe(AGENT_INSTALL[tool])
    for (const adapter of Object.keys(ACP_ADAPTER_INSTALL)) {
      expect(installCommandFor(adapter)).toBe(ACP_ADAPTER_INSTALL[adapter])
    }
  })

  it('answers undefined for a name no table covers, rather than off the prototype', () => {
    expect(installCommandFor('rustup')).toBeUndefined()
    // A plain object answers for its prototype too: without an own-property
    // check this hands back a Function where a command string belongs, and
    // the caller runs it through a shell.
    expect(installCommandFor('toString')).toBeUndefined()
    expect(installCommandFor('constructor')).toBeUndefined()
  })

  it('installs through npm, whose global bin the server can actually see', () => {
    // A vendor installer that drops a binary in ~/.local/bin can "succeed"
    // into a directory the server's PATH never searches — which reads, to
    // the create's preflight, as an install that did nothing.
    for (const tool of AGENT_TOOLS) expect(AGENT_INSTALL[tool]).toMatch(/^npm install -g /)
  })
})
