// Barrel for `#runtime/terminals`. Two entry points: the workspaces route
// lists and manages the windows of a workspace's `yaac` tmux session, and
// the /pty/attach WebSocket hands each connection to attachPty, which owns
// everything that connection creates (its per-client tmux view session,
// the ghost sweep, window resizing, and teardown on close). The route
// supplies only the resolved unit name, a socket adapter over `ws`, and the
// raw query.
//
// The wire protocol, tmux argv, view lifecycle and query validation are
// internal and covered through these entry points.

export { attachPty, type SocketLike } from './pty-bridge'
export { createShellWindow, killWindowTerminal, listWorkspaceTerminals } from './terminals'
