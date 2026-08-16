/**
 * Which host variables could point a tool away from the project dirs this
 * driver staged, and which of them this host is setting.
 *
 * Its own module because two surfaces need the same answer and neither
 * should have to load the other to get it: `launch` clears these, and
 * `check` reports them ahead of any create — and `check` is what `yaac host
 * check` imports, so a dependency on the launch path would pull the
 * workspace registry into the CLI to answer a question about `process.env`.
 */

/**
 * Every host variable that could point a tool somewhere other than the
 * project dirs this driver staged, cleared out of a workspace's inherited
 * environment.
 *
 * A worktree reaches its tool homes two ways, and the difference is what
 * this list is for. Where a tool has a real home override — claude's
 * `CLAUDE_CONFIG_DIR`, codex's `CODEX_HOME`, pi's `PI_CODING_AGENT_DIR` —
 * the create SETS it to the project's own directory, which beats anything
 * the host said. Where a tool has none, the home is reached HOME-relative
 * through the staged symlinks, so the only defense is that nothing redirects
 * it. Those variables are cleared here.
 *
 * The ones the create sets are cleared too. It costs nothing, and it makes
 * the invariant "no host tool-home value survives into a workspace" true on
 * its own rather than true only as long as every create remembers to
 * re-supply one.
 *
 * Verified against the binaries this host runs, because a name is only worth
 * listing if the tool reads it and the docs drift from the pin:
 *
 * - claude: `CLAUDE_CONFIG_DIR` is the config home, taken first
 *   (`process.env.CLAUDE_CONFIG_DIR ?? <home>/.claude`), and also names its
 *   macOS Keychain item; `CLAUDE_SECURESTORAGE_CONFIG_DIR` re-points its
 *   secure-storage dir.
 * - codex: `CODEX_HOME` is the home (log dir, sqlite home, state paths);
 *   `CODEX_SQLITE_HOME` re-points its session database on its own.
 * - pi: `PI_CODING_AGENT_DIR` is the config dir holding `auth.json`,
 *   `settings.json`, models and tools. (`PI_CODING_AGENT_SESSION_DIR` needs
 *   no entry: every create sets it unconditionally, on both drivers.)
 * - opencode: has NO home override. `OPENCODE_CONFIG_DIR`,
 *   `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` are additional config
 *   INPUTS — the first is pushed onto the list of directories it loads from,
 *   so a host value injects the server user's own opencode config (and any
 *   provider keys in it) no matter what else is set. Its actual homes come
 *   from `XDG_CONFIG_HOME`/`XDG_DATA_HOME`, which is why the XDG family is
 *   here and why nothing can be set in their place: cleared, opencode
 *   resolves `$HOME/.config/opencode` and `$HOME/.local/share/opencode`,
 *   which are the staged links.
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

/**
 * The ones this host sets, and a worktree therefore will not see — what
 * `yaac host check` reports and what a create says it ignored.
 *
 * Resolved here rather than at each surface so the drop and the report
 * cannot come to different conclusions about what counts as set. Empty is
 * not set: every tool here reads an empty value as absent, so reporting one
 * would warn about something that changes nothing.
 */
export function overriddenToolHomeVars(): string[] {
  // eslint-disable-next-line no-process-env -- the host's own environment is the subject of this report
  const host = process.env
  return [...TOOL_HOME_VARS].filter((key) => (host[key] ?? '') !== '')
}
