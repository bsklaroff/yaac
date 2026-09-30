/**
 * The agent binaries the containerless driver runs, each from yaac's own
 * install of its package. The driver installs a package the first time a
 * create needs it and puts every package's bin dir ahead of the host's PATH.
 * This lives in shared because the e2e tier stages stand-in agents at these
 * paths.
 *
 * Versions are pinned to `AGENT_CLIS` and `ACP_ADAPTERS`, the same ones the
 * image installs, because yaac's permission postures were verified against
 * those releases. A CLI the host already has is never used: an older codex
 * opens an update screen, and a newer one may have dropped a flag yaac
 * passes.
 */
import path from 'node:path'
import { nodeLocalPath } from '#project-paths'
import { ACP_ADAPTERS, AGENT_CLIS, AGENT_TOOLS } from '#types'

export interface AgentPackage {
  package: string
  version: string
  /**
   * Whether npm runs the package's lifecycle scripts. Opt-in, so no
   * third-party script runs unreviewed. Only claude and opencode need theirs,
   * to put their native binary in place.
   */
  runScripts: boolean
}

/**
 * Keyed by the binary a launch execs: an agent CLI, or an ACP adapter that
 * is a separate program. opencode's adapter is its CLI (`opencode acp`).
 */
export const AGENT_PACKAGES: Record<string, AgentPackage> = Object.fromEntries([
  ...AGENT_TOOLS.map((tool): [string, AgentPackage] =>
    [tool, { ...AGENT_CLIS[tool], runScripts: tool === 'claude' || tool === 'opencode' }]),
  ...AGENT_TOOLS
    .filter((tool) => ACP_ADAPTERS[tool].binary !== tool)
    .map((tool): [string, AgentPackage] => {
      const { binary, package: pkg, verified } = ACP_ADAPTERS[tool]
      return [binary, { package: pkg, version: verified, runScripts: false }]
    }),
])

/**
 * NODE-LOCAL: the npm prefix a pinned package is installed under (binaries
 * in `<prefix>/bin`). Named by package and version, so a version bump
 * installs beside the old one and running workspaces keep theirs.
 */
export function agentPackagePrefix({ package: pkg, version }: AgentPackage): string {
  return nodeLocalPath('agent-tools', `${pkg.replace('/', '+')}@${version}`)
}

/** Every pinned package's bin dir — what a workspace's PATH leads with. */
export function agentBinDirs(): string[] {
  return Object.values(AGENT_PACKAGES).map((p) => path.join(agentPackagePrefix(p), 'bin'))
}
