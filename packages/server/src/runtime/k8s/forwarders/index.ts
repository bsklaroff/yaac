// The public interface of the forwarders feature. Everything outside this
// directory imports `#runtime/k8s/forwarders`; the SEALED_FOLDERS lint rule
// stops src from reaching past this file. Modules in here import each
// other by relative path, which is why they are unaffected by that rule.
//
// This feature owns the host↔pod TCP forwards a worktree's ports are
// reachable through, and the detector that notices a new listener inside
// the pod and offers it. Two invariants live behind the seal and are the
// reason callers get functions rather than the registry itself: a
// worktree's forwards are torn down as one set (a leaked forward outlives
// its pod and holds a host port), and the per-worktree count is capped, so
// a flood of forward-port actions can't exhaust host ports or streamd's
// stream budget.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/forwarders/.

export { forwardWorktreePort } from './forward-port'
export { restoreAllWorktreeForwarders } from './restore'
export {
  PortDetectorManager,
  dismissWorktreePort,
  getUnforwardedPorts,
} from './port-detector'
export {
  buildStatusRight,
  getWorktreePorts,
  hasWorktreeForwarders,
  provisionWorktreeForwarders,
  registerWorktreeForwarders,
  stopAllWorktreeForwarders,
  stopWorktreeForwarders,
} from './port-forwarders'
