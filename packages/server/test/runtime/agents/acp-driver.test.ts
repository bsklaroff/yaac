import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { acpAdapterFor } from '#runtime/agents/acp-adapters'
import { _ACP_PROFILES } from '#runtime/agents/acp-adapters'
import { ACP_ADAPTERS, ACP_TOOLS, PERMISSION_MODES } from '@yaac/shared/types'
import { ACP_ADAPTER_INSTALL } from '@yaac/shared/tool-install'
import { ACP_SUPPORTED_PERMISSION_MODES } from '@yaac/shared/types'
import type { AcpTool } from '@yaac/shared/types'

const DOCKERFILE = path.resolve(import.meta.dirname, '../../../../../dockerfiles/Dockerfile.tools')

/**
 * The driver itself is exercised through `agentDriver` (drivers.test.ts); this
 * covers what the adapter table answers on its own — which tools can run in
 * ACP mode, and whether what the table claims about each adapter is still
 * true of the version the image installs.
 */
describe('acpAdapterFor', () => {
  it('names an adapter profile for every tool the webapp offers a chat pane for', () => {
    // Two lists, one truth: a tool the webapp offers but the driver cannot
    // launch would fail at create time instead of being hidden from the menu.
    for (const tool of ACP_TOOLS) {
      expect(acpAdapterFor(tool), tool).toBeDefined()
    }
    expect(Object.keys(_ACP_PROFILES).sort()).toEqual([...ACP_TOOLS].sort())
  })

  it('launches each adapter as the binary the shared table names', () => {
    // The driver builds a launch command, the host preflight probes a PATH,
    // and the image installs a package — all three have to mean the same
    // binary, so the profile takes its name from the one shared record rather
    // than spelling it again.
    for (const tool of ACP_TOOLS) {
      const argv = _ACP_PROFILES[tool].argv({
        tool,
        agentSessionId: 'c',
        resume: false,
        windowName: tool,
        permissionMode: 'bypass',
      } as never)
      expect(argv[0], tool).toBe(ACP_ADAPTERS[tool].binary)
    }
  })

  it('offers a mode id for exactly the postures create will let through', () => {
    // The two halves of a posture actually being honored. Create refuses a
    // posture that is not in the ACP column, and the adapter is told the one
    // that is — so a posture in the column with no mode id has to be carried
    // some other way, and the profile says which: opencode's ride
    // `OPENCODE_PERMISSION` at launch, and pi has no permission system at all.
    for (const tool of ACP_TOOLS) {
      const withModeId = PERMISSION_MODES.filter(
        (m) => _ACP_PROFILES[tool].modeIds[m] !== undefined,
      )
      const supported = ACP_SUPPORTED_PERMISSION_MODES[tool]
      // Never a mode id for a posture create would refuse: that would be a
      // posture reachable only by a caller who bypassed the refusal.
      expect(withModeId.filter((m) => !supported.includes(m)), tool).toEqual([])
    }
    // The carried-elsewhere cases, stated so a silent change to either table
    // has to be deliberate.
    expect(PERMISSION_MODES.filter((m) => _ACP_PROFILES.claude.modeIds[m] === undefined)).toEqual([])
    expect(_ACP_PROFILES.opencode.modeIds).toEqual({ plan: 'plan' })
    expect(_ACP_PROFILES.pi.modeIds).toEqual({})
  })

  it('has an install command for every adapter that is not the tool itself', () => {
    // `--install-missing` and `yaac host check`'s advice both read this, and a
    // missing row degrades to naming a binary with no way to get it.
    for (const tool of ACP_TOOLS) {
      const { binary } = ACP_ADAPTERS[tool]
      if (binary === tool) continue
      expect(ACP_ADAPTER_INSTALL[binary], binary).toBeDefined()
    }
  })

  it('was verified against the adapter versions the image installs', () => {
    // The pin that keeps the mode tables honest. An adapter that stops
    // advertising a mode does not fail — the session silently runs in its
    // default — so nothing but this catches a bump that moved the vocabulary
    // out from under `modeIds`. Re-verify against the new version, then move
    // the pin here.
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')
    const installed = (pkg: string): string | undefined =>
      new RegExp(`${pkg.replace(/[/@.]/g, '\\$&')}@(\\S+)`).exec(dockerfile)?.[1]
    const pins: Record<AcpTool, string | undefined> = {
      claude: installed('@agentclientprotocol/claude-agent-acp'),
      codex: installed('@agentclientprotocol/codex-acp'),
      // opencode's adapter is a subcommand of the CLI, so the CLI's pin is the
      // adapter's pin.
      opencode: installed('opencode-ai'),
      pi: installed('pi-acp'),
    }
    for (const tool of ACP_TOOLS) {
      expect(pins[tool], `${tool}: no pinned version in Dockerfile.tools`).toBeDefined()
      expect(_ACP_PROFILES[tool].verifiedAgainst, tool).toBe(pins[tool])
    }
  })
})
