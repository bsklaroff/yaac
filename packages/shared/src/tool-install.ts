/**
 * The agent binaries a host runs its workspaces with, each from yaac's own
 * install of the package that ships it.
 *
 * Only a runtime with no image to supply the tools needs this — the
 * containerless driver, which installs a package the first time a create
 * needs one of its binaries and puts every package's bin dir ahead of the
 * host's own PATH. It lives in shared rather than beside that driver because
 * the e2e tier stages its stand-in agents at exactly these paths.
 *
 * Pinned to `AGENT_CLIS` and `ACP_ADAPTERS`, the same versions the image
 * installs: yaac's postures are written against each CLI's flags and read
 * back from what it reports, so a host running another release is a host
 * where a posture can silently mean something else. That is why a CLI the
 * host already has is never used: a codex behind the latest release opens an
 * update screen, one ahead of it can have dropped a policy yaac launches, and
 * either reads as yaac being broken.
 */
import path from 'node:path'
import { nodeLocalPath } from '#project-paths'
import { ACP_ADAPTERS, AGENT_CLIS, AGENT_TOOLS } from '#types'

export interface AgentPackage {
  package: string
  version: string
  /**
   * Whether npm runs the package's lifecycle scripts — opt-in, so a pin bump
   * that adds one is a deliberate change rather than third-party code picked
   * up silently. Only claude and opencode need theirs: each postinstall puts
   * the native binary in place, and without it the CLI refuses to start.
   * codex's binary arrives as an exact-pinned optionalDependency, which is
   * installed either way; pi's postinstall fetches a platform binary yaac does
   * not need; the adapters have none.
   */
  runScripts: boolean
}

/**
 * Keyed by the BINARY a launch execs — an agent CLI, or an ACP adapter that
 * is a separate program. opencode's adapter is its CLI (`opencode acp`), so
 * it has one entry.
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
 * NODE-LOCAL: the npm prefix one pinned package is installed under — its
 * binaries land in `<prefix>/bin`. Named by package and version, so a
 * prefix never changes once it exists: a version bump installs beside it,
 * and a workspace launched against the old one keeps running what it
 * started with.
 */
export function agentPackagePrefix({ package: pkg, version }: AgentPackage): string {
  return nodeLocalPath('agent-tools', `${pkg.replace('/', '+')}@${version}`)
}

/** Every pinned package's bin dir — what a workspace's PATH leads with. */
export function agentBinDirs(): string[] {
  return Object.values(AGENT_PACKAGES).map((p) => path.join(agentPackagePrefix(p), 'bin'))
}
