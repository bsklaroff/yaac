// The public interface of the forwarders feature. Everything outside this
// directory imports `#drivers/k8s/forwarders`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each
// other by relative path, which is why they are unaffected by that rule.
//
// This feature owns which of a worktree's ports are offered, and at which
// host port — plus the detector that notices a new listener inside the pod
// and offers it. Nothing here binds: the listener belongs to a client
// (`yaac forward`, the desktop app), and `dialWorkspacePort` is the near
// end it tunnels back through. Two invariants live behind the seal and are
// the reason callers get functions rather than the registry itself: a
// worktree's forwards are dropped as one set, and the per-worktree count
// is capped, so a flood of forward-port actions can't exhaust the host
// port space or streamd's stream budget.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/forwarders/.

export { dialWorkspacePort, forwardWorktreePort } from './forward-port'
export {
  PortDetectorManager,
  dismissWorktreePort,
  getUnforwardedPorts,
} from './port-detector'
export {
  declareWorktreeForwards,
  getWorktreePorts,
  stopAllWorktreeForwarders,
  stopWorktreeForwarders,
} from './port-forwarders'
