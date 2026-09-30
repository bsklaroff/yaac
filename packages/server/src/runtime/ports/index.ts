// Driver-neutral port forwarding over the contract's `declareForwards` and
// `dialPort`: which ports a workspace carries, keeping the tmux bar in
// step, and bridging a client socket to a connection in the workspace.
// Where a forward is offered and how a dial travels are the driver's.
//
// Each export needs a unit test in packages/server/test/runtime/ports/.

export { restoreAllWorkspaceForwarders } from './restore'
export {
  TUNNEL_DIAL_FAILED,
  attachPortTunnel,
  type TunnelSocketLike,
} from './tunnel'
