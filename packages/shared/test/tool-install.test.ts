import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_PACKAGES, agentBinDirs, agentPackagePrefix } from '#tool-install'
import { nodeLocalRoot } from '#paths'
import { ACP_ADAPTERS, AGENT_CLIS, AGENT_TOOLS } from '#types'

describe('AGENT_PACKAGES', () => {
  it('pins every binary a launch can exec to the version its behavior was verified against', () => {
    // A missing entry can't be installed, and an unpinned version's
    // postures were never checked.
    for (const tool of AGENT_TOOLS) {
      const { package: cliPkg, version } = AGENT_CLIS[tool]
      expect(AGENT_PACKAGES[tool]).toMatchObject({ package: cliPkg, version })
      const { binary, package: pkg, verified } = ACP_ADAPTERS[tool]
      expect(AGENT_PACKAGES[binary], binary).toMatchObject({ package: pkg, version: verified })
    }
  })

  it('runs install scripts only for the packages whose binary one puts in place', () => {
    // Everything else is third-party code with nothing yaac needs from it.
    const running = Object.entries(AGENT_PACKAGES).filter(([, p]) => p.runScripts).map(([b]) => b)
    expect(running.sort()).toEqual(['claude', 'opencode'])
  })
})

describe('agentPackagePrefix', () => {
  it('names one immutable node-local prefix per package version', () => {
    const codex = AGENT_PACKAGES.codex
    const prefix = agentPackagePrefix(codex)
    expect(path.dirname(prefix)).toBe(path.join(nodeLocalRoot(), 'agent-tools'))
    // A bump installs beside the old version, so running workspaces keep
    // theirs.
    expect(agentPackagePrefix({ ...codex, version: '9.9.9' })).not.toBe(prefix)
    // A scoped package stays one path segment.
    expect(path.basename(prefix)).toBe(`@openai+codex@${codex.version}`)
  })
})

describe('agentBinDirs', () => {
  it('answers each package bin dir once', () => {
    const dirs = agentBinDirs()
    expect(new Set(dirs).size).toBe(Object.keys(AGENT_PACKAGES).length)
    expect(dirs).toContain(path.join(agentPackagePrefix(AGENT_PACKAGES['codex-acp']), 'bin'))
  })
})
