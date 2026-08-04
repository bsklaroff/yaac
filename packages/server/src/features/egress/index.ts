// The public interface of the egress feature. Everything outside this
// directory imports `#features/egress`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// This feature owns the *policy* side of the shared egress proxy: which
// hosts a session may reach, the secrets and redirects injected on its
// behalf, and the registration that carries all of it to the sidecar.
// (`#features/cluster` owns standing the sidecar itself up; this owns what
// it is told once it is running.)
//
// Every path in here is fail-closed by design — an unregistered session
// reaches nothing — so the interface is deliberately narrow: callers
// register a session, widen it, or read what it was denied. The rule
// builder, the secret collector and the redirect parser stay internal so a
// caller cannot assemble a half-registration of its own.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/features/egress/.

export { allowSessionHost } from './allow-host'
export { readBlockedHosts } from './blocked-hosts'
export { hostMatchesPattern, resolveAllowedHosts } from './default-allowed-hosts'
export {
  ProxyClient,
  proxyClient,
  resolveProxyImageTag,
  type PendingSpawn,
  type ProxyClientConfig,
  type SpawnResultWire,
} from './proxy-client'
export { reconcileProxySshKeys } from './proxy-reconcile'
export { buildSessionRegistration, syncProxySecrets } from './proxy-registration'
export { reconcileVclusterAttribution } from './vcluster-attribution'
