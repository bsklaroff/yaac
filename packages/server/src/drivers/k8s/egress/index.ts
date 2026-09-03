// The public interface of the egress feature. Everything outside this
// directory imports `#drivers/k8s/egress`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature owns the *policy* side of the shared egress proxy: which
// hosts a worktree may reach, the secrets and redirects injected on its
// behalf, and the registration that carries all of it to the sidecar.
// (`#drivers/k8s/cluster` owns standing the sidecar itself up; this owns what
// it is told once it is running.)
//
// Every path in here is fail-closed by design — an unregistered worktree
// reaches nothing — so the interface is deliberately narrow: callers
// register a worktree, widen it, or read what it was denied. The rule
// builder and the redirect parser stay internal so a caller cannot assemble
// a half-registration of its own.
//
// Secrets travel in one direction only: a registration names them and
// carries their injection rules, and the values arrive already resolved
// (`pushProxySecrets`) because where a secret comes from is never the
// runtime's question. Neither the values nor the ssh keys ever reach the
// proxy's filesystem — both are pushed into its memory, which is why both
// need a reader composed in (`configureProxyCredentials`) to restore them
// after a pod replacement.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/egress/.

export { allowWorktreeHost } from './allow-host'
export { readBlockedHosts } from './blocked-hosts'
export { readAllGitAuthFailures, readGitAuthFailures } from './git-auth-failures'
export {
  ProxyClient,
  drainPendingMamaRequests,
  proxyClient,
  type ProxyClientConfig,
} from './proxy-client'
export { PROXY_CHANGE_SOURCES, ProxyEventStream, type ProxyChangeSource } from './proxy-events'
export { reconcileProxySshKeys } from './proxy-reconcile'
export { workspaceSshTransport } from './ssh-transport'
export { buildWorktreeRegistration, registerWorkspace } from './proxy-registration'
export { pushProxySecrets, syncProjectProxySecrets } from './proxy-secrets'
export {
  configureProxyCredentials,
  type ProxyCredentialSources,
} from './credential-providers'
