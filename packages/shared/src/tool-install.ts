/**
 * The agent binaries the containerless driver runs, each from yaac's own
 * install of its package (or, for omp, its release binary). The driver
 * installs one the first time a create needs it and puts every install's
 * bin dir ahead of the host's PATH.
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
   * third-party script runs unreviewed. Only claude and opencode need
   * theirs, to put their native binary in place.
   */
  runScripts: boolean
  /**
   * A release binary installed in place of the npm package, as the image
   * does: the asset `<urlBase><platform>` for the host's platform
   * (`<os>[-musl]-<arch>`, in Node's names), checked against its `sha256`
   * and saved as `<prefix>/lib/<binary>/<binary>`.
   */
  release?: { urlBase: string; sha256: Partial<Record<string, string>> }
  /**
   * A script in `dockerfiles/agent-patches/` the install runs on the package
   * once it is in place, as the image build does, given the path of `entry`
   * in the package's dir (`lib/<binary>/` for a release): the file it edits,
   * or their folder. `revision` names the patched install apart from an
   * unpatched or older one, so bump it whenever the script changes.
   */
  patch?: { script: string; entry: string; revision: number }
}

/** Packages yaac patches after installing; see `AgentPackage.patch`. */
const PATCHES: Record<string, AgentPackage['patch']> = {
  'claude-agent-acp': { script: 'claude-agent-acp.js', entry: 'dist', revision: 3 },
  'pi-acp': { script: 'pi-acp.js', entry: 'dist/index.js', revision: 7 },
  omp: { script: 'omp-homes.js', entry: 'omp', revision: 3 },
}

/**
 * Keyed by the binary a launch execs: an agent CLI, or an ACP adapter that
 * is a separate program. opencode's and omp's adapters are their CLIs
 * (`opencode acp`, `omp acp`).
 */
export const AGENT_PACKAGES: Record<string, AgentPackage> = Object.fromEntries([
  ...AGENT_TOOLS.map((tool): [string, AgentPackage] => {
    const patch = PATCHES[tool]
    return [tool, {
      package: AGENT_CLIS[tool].package,
      version: AGENT_CLIS[tool].version,
      runScripts: tool === 'claude' || tool === 'opencode',
      ...(tool === 'omp' ? {
        release: {
          urlBase: `https://github.com/can1357/oh-my-pi/releases/download/v${AGENT_CLIS.omp.version}/omp-`,
          sha256: AGENT_CLIS.omp.binarySha256,
        },
      } : {}),
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
