// The public interface of the forwarders feature (sealed folder; see the
// SEALED_FOLDERS lint rule).
//
// It decides which of a workspace's ports are offered and at which host
// port, and detects new listeners inside the pod. Nothing here binds a
// port: a client (`yaac forward`, the desktop app) holds the listener and
// tunnels each connection back through `dialWorkspacePort`
// (docs/port-forward-tunnel.md). Callers get functions rather than the
// registry so that a workspace's forwards are always dropped together and
// the per-workspace count stays capped.
//
// Each name exported here needs a unit test in
// packages/server/test/drivers/k8s/forwarders/.

export { dialWorkspacePort, forwardWorkspacePort } from './forward-port'
export {
  PortDetectorManager,
  dismissWorkspacePort,
  getUnforwardedPorts,
} from './port-detector'
export {
  declareWorkspaceForwards,
  getWorkspacePorts,
  stopAllWorkspaceForwarders,
  stopWorkspaceForwarders,
} from './port-forwarders'
