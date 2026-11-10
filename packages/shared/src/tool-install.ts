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
import { ACP_ADAPTERS, AGENT_CLIS, AGENT_TOOLS, BUN_RUNTIME } from '#types'

export interface AgentPackage {
  package: string
  version: string
  /**
   * Whether npm runs the package's lifecycle scripts. Opt-in, so no
   * third-party script runs unreviewed. Only claude, opencode and bun need
   * theirs, to put their native binary in place.
   */
  runScripts: boolean
  /**
   * A script in `dockerfiles/agent-patches/` the install runs on the package
   * after npm, as the image build does, given the path of `entry`. `revision` names the patched install
   * apart from an unpatched or older one, so bump it whenever the script
   * changes.
   */
  patch?: { script: string; entry: string; revision: number }
}

/** Packages yaac patches after installing; see `AgentPackage.patch`. */
const PATCHES: Record<string, AgentPackage['patch']> = {
  'pi-acp': { script: 'pi-acp.js', entry: 'dist/index.js', revision: 6 },
  omp: { script: 'omp-homes.js', entry: 'dist/cli.js', revision: 2 },
}

/**
 * Keyed by the binary a launch execs: an agent CLI, an ACP adapter that is
 * a separate program, or bun, which omp runs under. opencode's and omp's
 * adapters are their CLIs (`opencode acp`, `omp acp`).
 */
export const AGENT_PACKAGES: Record<string, AgentPackage> = Object.fromEntries([
  ...AGENT_TOOLS.map((tool): [string, AgentPackage] => {
    const patch = PATCHES[tool]
    return [tool, {
      package: AGENT_CLIS[tool].package,
      version: AGENT_CLIS[tool].version,
      runScripts: tool === 'claude' || tool === 'opencode',
      ...(patch ? { patch } : {}),
    }]
  }),
  ...AGENT_TOOLS
    .filter((tool) => ACP_ADAPTERS[tool].binary !== tool)
    .map((tool): [string, AgentPackage] => {
      const { binary, package: pkg, verified } = ACP_ADAPTERS[tool]
      const patch = PATCHES[binary]
      return [binary, { package: pkg, version: verified, runScripts: false, ...(patch ? { patch } : {}) }]
    }),
  ['bun', { package: BUN_RUNTIME.package, version: BUN_RUNTIME.version, runScripts: true }],
])

/**
 * NODE-LOCAL: the npm prefix a pinned package is installed under (binaries
 * in `<prefix>/bin`). Named by package, version and patch revision, so a
 * bump installs beside the old one and running workspaces keep theirs.
 */
export function agentPackagePrefix({ package: pkg, version, patch }: AgentPackage): string {
  const revision = patch === undefined ? '' : `+yaac.${patch.revision}`
  return nodeLocalPath('agent-tools', `${pkg.replace('/', '+')}@${version}${revision}`)
}

/** Every pinned package's bin dir — what a workspace's PATH leads with. */
export function agentBinDirs(): string[] {
  return Object.values(AGENT_PACKAGES).map((p) => path.join(agentPackagePrefix(p), 'bin'))
}
