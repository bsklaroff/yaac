import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { acpAdapterFor, _ACP_PROFILES } from '#runtime/agents/acp-adapters'
import {
  ACP_ADAPTERS,
  ACP_SUPPORTED_PERMISSION_MODES,
  AGENT_TOOLS,
  PERMISSION_MODES,
} from '@yaac/shared/types'
import { installCommandFor } from '@yaac/shared/tool-install'

const DOCKERFILE = path.resolve(import.meta.dirname, '../../../../../dockerfiles/Dockerfile.tools')

/**
 * The adapter profiles are the per-tool half of ACP mode: what a launch
 * command carries, and what a posture becomes on the wire. Driving them is
 * `drivers.test.ts` (launchCmd and the handshakes); what is left for here is
 * whether the table still describes the adapters this build actually installs.
 */
describe('acpAdapterFor', () => {
  it('has a profile for every tool, launching the binary the shared record names', () => {
    // Total, so there is no "this tool cannot do acp" case for a caller to
    // handle. The driver builds a launch command, the host preflight probes a
    // PATH, and the image installs a package — all three have to mean the same
    // binary, so the profile takes its name from the one record rather than
    // spelling it again.
    for (const tool of AGENT_TOOLS) {
      const argv = acpAdapterFor(tool).argv({
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
    for (const tool of AGENT_TOOLS) {
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

  it('installs, on a host, the version its behavior was verified against', () => {
    // `--install-missing` and `yaac host check`'s advice both read this. A host
    // that installed today's release of an adapter whose modes were checked
    // against an older one is the same silent drift the Dockerfile pin exists
    // to prevent — so both derive from `verified`.
    for (const tool of AGENT_TOOLS) {
      const { binary, package: pkg, verified } = ACP_ADAPTERS[tool]
      // opencode's adapter is its own CLI, installed on the CLI's terms.
      if (binary === tool) continue
      expect(installCommandFor(binary), binary).toContain(`${pkg}@${verified}`)
    }
  })

  it('was verified against the adapter versions the image installs', () => {
    // The pin that keeps the mode tables honest. An adapter that stops
    // advertising a mode does not fail — the session silently runs in its
    // default — so nothing but this catches a bump that moved the vocabulary
    // out from under `modeIds`. Re-verify against the new version, then move
    // `verified` in the shared record.
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')
    for (const tool of AGENT_TOOLS) {
      const { package: pkg, verified } = ACP_ADAPTERS[tool]
      const installed = new RegExp(`${pkg.replace(/[/@.]/g, '\\$&')}@(\\S+)`).exec(dockerfile)?.[1]
      expect(installed, `${tool}: ${pkg} is not pinned in Dockerfile.tools`).toBe(verified)
    }
  })
})
