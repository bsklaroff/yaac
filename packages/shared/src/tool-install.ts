/**
 * How to install each agent CLI and ACP adapter on a host.
 *
 * Only a runtime with no image to supply the tools needs this — the
 * containerless driver, whose preflight refuses a create naming a tool this
 * host does not have and whose `--install-missing` path runs the command
 * itself. It lives in shared rather than beside that driver because
 * `yaac host check`'s advice reads from the same table, and two hand-kept
 * copies of an install command drift the moment one package is renamed.
 *
 * Pinned to `AGENT_CLIS`, the same versions the image installs: yaac's
 * postures are written against each CLI's flags and read back from what it
 * reports, so a host running another release is a host where a posture can
 * silently mean something else. That covers what yaac installs; a CLI the
 * host already has is used as it is (docs/containerless-driver.md).
 *
 * npm over each vendor's curl-installer, also deliberately: npm's global bin
 * is on the PATH the server itself was started from (node is how yaac runs),
 * while an installer that drops a binary in `~/.local/bin` can "succeed"
 * into a directory the server's environment never searches — which reads,
 * to every check here, as an install that did nothing.
 */
import { ACP_ADAPTERS, AGENT_CLIS, AGENT_TOOLS, type AgentTool } from '#types'

export const AGENT_INSTALL = Object.fromEntries(AGENT_TOOLS.map((tool) => {
  const { package: pkg, version } = AGENT_CLIS[tool]
  // --ignore-scripts for pi matches how the image installs it: its
  // postinstall fetches a platform binary yaac does not need.
  return [tool, `npm install -g ${tool === 'pi' ? '--ignore-scripts ' : ''}${pkg}@${version}`]
})) as Record<AgentTool, string>

/**
 * Keyed by the adapter's BINARY name — what `--mode acp` execs and what a PATH
 * probe looks for — not by the tool it adapts, and derived from `ACP_ADAPTERS`
 * so the version a host installs is the version yaac's description of that
 * adapter was verified against: what yaac reads off an adapter is its
 * advertised session modes, and an adapter that stops advertising one runs in
 * its default rather than failing.
 *
 * opencode is absent because its adapter IS its CLI (`opencode acp`), so
 * `AGENT_INSTALL` already answers for it.
 * `installCommandFor` checks the tools first, which is what makes that fall
 * through correctly.
 *
 * `--ignore-scripts` because neither package has a lifecycle script to run and
 * a future one would be fetching a platform binary the image already has. It
 * does NOT keep codex-acp's dependency on `@openai/codex` from landing a
 * second copy of the codex binary: that arrives as an optionalDependency,
 * which the flag does not skip. Harmless — codex-acp execs `CODEX_PATH ??
 * "codex"`, i.e. the one already on PATH.
 */
export const ACP_ADAPTER_INSTALL: Record<string, string> = Object.fromEntries(
  AGENT_TOOLS
    .filter((tool) => ACP_ADAPTERS[tool].binary !== tool)
    .map((tool) => {
      const { binary, package: pkg, verified } = ACP_ADAPTERS[tool]
      return [binary, `npm install -g --ignore-scripts ${pkg}@${verified}`]
    }),
)

/**
 * The install command for an agent binary or ACP adapter binary, or
 * undefined for a name no table covers (a future adapter, say) — callers
 * degrade to naming the binary without advice rather than guessing.
 *
 * `Object.hasOwn` rather than a bare lookup: a plain object answers for its
 * prototype too, so `'toString'` would otherwise come back "defined" and
 * hand a caller a Function where a command string belongs.
 */
export function installCommandFor(binary: string): string | undefined {
  if ((AGENT_TOOLS as readonly string[]).includes(binary)) return AGENT_INSTALL[binary as AgentTool]
  return Object.hasOwn(ACP_ADAPTER_INSTALL, binary) ? ACP_ADAPTER_INSTALL[binary] : undefined
}
