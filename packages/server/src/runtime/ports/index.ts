// The port-forwarding machinery: driver-neutral orchestration over the
// contract's `declareForwards` and `dialPort`.
//
// What lives here is everything that is the same whichever substrate runs
// the workspace — deciding which ports a workspace should carry, keeping
// the tmux bar's advertisement in step, and bridging one client's socket to
// one connection inside the workspace. What a forward is offered at, and
// what a dial actually traverses, are the driver's half and stay on the
// contract.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/runtime/ports/.

export { restoreAllWorkspaceForwarders } from './restore'
export {
  TUNNEL_DIAL_FAILED,
  attachPortTunnel,
  type TunnelSocketLike,
} from './tunnel'
