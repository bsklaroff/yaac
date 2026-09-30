// The public interface of the egress feature. Everything outside this
// directory imports `#drivers/k8s/egress`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature owns the *policy* side of the shared egress proxy: which
// hosts a workspace may reach, the secrets and redirects injected on its
// behalf, and the registration that carries all of it to the sidecar.
// (`#drivers/k8s/cluster` owns standing the sidecar itself up and the
// objects that hand it its credentials; this owns what it is told per
// workspace once it is running, and what it reports back.)
//
// Every path in here is fail-closed by design — an unregistered workspace
// reaches nothing — so the interface is deliberately narrow: callers
// register a workspace, widen it, or read what it was denied. The rule
// builder and the redirect parser stay internal so a caller cannot assemble
// a half-registration of its own.
//
// Secrets travel in one direction only: a registration names them and
// carries their injection rules; the values reach the proxy by their own
// object (`syncProjectSecrets`, in `#drivers/k8s/cluster`), because where a
// secret comes from is never the runtime's question.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/drivers/k8s/egress/.

export {
  ProxyClient,
  drainPendingMamaRequests,
  proxyClient,
  type ProxyClientConfig,
} from './proxy-client'
export { PROXY_CHANGE_SOURCES, ProxyEventStream, type ProxyChangeSource } from './proxy-events'
export {
  allowWorkspaceHost,
  applyProxyRegistration,
  buildProxyRegistration,
  deregisterWorkspaceEgress,
  reconcileRegistrationGc,
  registerWorkspaceEgress,
  type ProxyRegistration,
} from './proxy-registration'
export {
  readAllGitAuthFailures,
  readBlockedHosts,
  readGitAuthFailures,
  refreshedCredentials,
} from './proxy-state'
export { workspaceSshTransport } from './ssh-transport'
