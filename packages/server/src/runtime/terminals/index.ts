// Barrel for `#runtime/terminals`: the windows of a workspace's `yaac` tmux
// session. The status watcher lists them (so the snapshot carries them), the
// workspaces route creates and kills them, and the /pty/attach WebSocket
// hands each connection to attachPty, which owns everything that connection
// creates (the webapp's pane mirror viewers, the CLI's tmux view sessions
// and their ghost sweep, and teardown on close). The route supplies only the
// resolved unit name, a socket adapter over `ws`, and the raw query.
//
// The wire protocol, the pane mirror, tmux argv, view lifecycle and query
// validation are internal and covered through these entry points.

export { attachPty } from './pty-bridge'
export type { SocketLike } from './socket'
export { createShellWindow, killWindowTerminal, listTerminals } from './terminals'
