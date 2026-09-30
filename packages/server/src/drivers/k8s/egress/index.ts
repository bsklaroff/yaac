// The public interface of the egress feature (a sealed folder; see
// SEALED_FOLDERS).
//
// This feature owns what the shared egress proxy is told per workspace
// (allowed hosts, injection rules, redirects) and what it reports back.
// `#drivers/k8s/cluster` deploys the proxy and hands it credentials and
// secret values (`syncProjectSecrets`); registrations name secrets but never
// carry values. An unregistered workspace reaches nothing. The rule builder
// stays internal so callers cannot build partial registrations.
//
// Each name added here needs a unit test in
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
