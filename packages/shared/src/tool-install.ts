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
 * Unpinned, deliberately: a host wants whatever the tool's current release
 * is, and a version fixed here would rot silently. That is the opposite of
 * the image's pins (dockerfiles/Dockerfile.tools), which exist so every
 * worktree in a cluster runs the same build.
 *
 * npm over each vendor's curl-installer, also deliberately: npm's global bin
 * is on the PATH the server itself was started from (node is how yaac runs),
 * while an installer that drops a binary in `~/.local/bin` can "succeed"
 * into a directory the server's environment never searches — which reads,
 * to every check here, as an install that did nothing.
 */
import { AGENT_TOOLS, type AgentTool } from '#types'

export const AGENT_INSTALL: Record<AgentTool, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  opencode: 'npm install -g opencode-ai',
  // --ignore-scripts matches how the image installs it: its postinstall
  // fetches a platform binary yaac does not need.
  pi: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
}

/**
 * Keyed by the adapter's BINARY name — what `--mode acp` execs and what a
 * PATH probe looks for — not by the tool it adapts.
 *
 * opencode is absent on purpose: `opencode acp` is a subcommand, so its adapter
 * IS the CLI and `AGENT_INSTALL` already answers for it. `installCommandFor`
 * checks the tools first, which is what makes that fall through correctly.
 *
 * `--ignore-scripts` where the package's postinstall fetches a platform binary
 * it does not need (the same reason pi's own install carries it): both adapters
 * are plain JavaScript that resolve their native pieces through the tool they
 * drive.
 */
export const ACP_ADAPTER_INSTALL: Record<string, string> = {
  'claude-agent-acp': 'npm install -g @agentclientprotocol/claude-agent-acp',
  'codex-acp': 'npm install -g --ignore-scripts @agentclientprotocol/codex-acp',
  'pi-acp': 'npm install -g --ignore-scripts pi-acp',
}

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
