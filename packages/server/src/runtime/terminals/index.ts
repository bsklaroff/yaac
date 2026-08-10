// The public interface of the terminals feature. Everything outside this
// directory imports `#runtime/terminals`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// Two entry points, one consumer each. The worktrees route enumerates and
// manages the windows of a session's `yaac` tmux session; the server's
// /pty/attach WebSocket hands one connection to attachPty, which owns
// everything that connection creates in the pod — its per-client tmux view
// worktree, the ghost sweep, the window-resize driver, and the teardown on
// close. The route supplies only what it alone can: the resolved Job name,
// a socket adapter over `ws`, and the raw query string.
//
// The wire protocol, the tmux argv, the view lifecycle and the query
// validation are all internal, covered through those two entry points.

export { attachPty, type SocketLike } from './pty-bridge'
export { createShellWindow, killWindowTerminal, listWorktreeTerminals } from './terminals'
