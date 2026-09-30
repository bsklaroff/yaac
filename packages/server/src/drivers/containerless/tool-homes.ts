/**
 * Host variables that could point a tool away from the project dirs this
 * driver stages. Shared by `launch` (clears them) and `check` (reports
 * them); separate so `yaac host check` does not load the launch path.
 */

/**
 * Host variables cleared from a workspace's inherited environment. Tools
 * with a home variable (claude, codex, pi) get it set by the create anyway;
 * tools without one (opencode) find their home via `$HOME`, so nothing may
 * redirect it. Checked against the pinned binaries:
 *
 * - claude: `CLAUDE_CONFIG_DIR` (also names its macOS Keychain item),
 *   `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
 * - codex: `CODEX_HOME`, `CODEX_SQLITE_HOME`.
 * - pi: `PI_CODING_AGENT_DIR`. (`PI_CODING_AGENT_SESSION_DIR` is always set
 *   by the create.)
 * - opencode: no home variable. `OPENCODE_CONFIG*` add config inputs (a host
 *   value would inject the user's own config and keys; yaac's own
 *   `OPENCODE_CONFIG_CONTENT` is set later on the launch command line). Its
 *   homes come from the XDG variables, which are cleared so it resolves
 *   `$HOME/.config/opencode` and `$HOME/.local/share/opencode`.
 */
export const TOOL_HOME_VARS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'PI_CODING_AGENT_DIR',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
])

/** The `TOOL_HOME_VARS` this host sets to a non-empty value (empty reads
 *  as unset to every tool). */
export function overriddenToolHomeVars(): string[] {
  // eslint-disable-next-line no-process-env -- the host's own environment is the subject of this report
  const host = process.env
  return [...TOOL_HOME_VARS].filter((key) => (host[key] ?? '') !== '')
}
