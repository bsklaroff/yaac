import { describe, it, expect } from 'vitest'
import { AGENT_INSTALL, ACP_ADAPTER_INSTALL, installCommandFor } from '#tool-install'
import { ACP_ADAPTERS, AGENT_TOOLS } from '#types'

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

  it('installs the adapter version its behavior was verified against', () => {
    // The agent CLIs above are deliberately unpinned — a host wants the
    // current release. Adapters are the opposite: what yaac reads off one is
    // the set of session modes it advertises, and an adapter that stops
    // advertising a posture's mode does not fail, it silently runs in its own
    // default. So a host installs the version that was actually checked.
    for (const tool of AGENT_TOOLS) {
      const { binary, package: pkg, verified } = ACP_ADAPTERS[tool]
      // opencode's adapter is its own CLI (`opencode acp`), installed on the
      // CLI's unpinned terms by `AGENT_INSTALL`.
      if (binary === tool) continue
      expect(installCommandFor(binary), binary).toContain(`${pkg}@${verified}`)
    }
  })

  it('installs through npm, whose global bin the server can actually see', () => {
    // A vendor installer that drops a binary in ~/.local/bin can "succeed"
    // into a directory the server's PATH never searches — which reads, to
    // the create's preflight, as an install that did nothing.
    for (const tool of AGENT_TOOLS) expect(AGENT_INSTALL[tool]).toMatch(/^npm install -g /)
  })
})
