/**
 * Which of a workspace's listening ports may be surfaced to the user at
 * all, and how many — and which may never be forwarded however they are
 * asked for.
 *
 * Policy rather than mechanism: HOW a driver discovers a workspace's
 * listeners is entirely its own (a stream daemon pushing `/proc/net/tcp`
 * from inside a pod, an `lsof` over a host process tree), but WHAT is safe
 * to offer is the same question either way, and config validation asks the
 * infra half of it too — which is why it sits in `#lib`, open to domain as
 * well as both drivers. Fail closed: a port that reaches a list is one click
 * from being reachable.
 *
 * Two tiers, told apart by intent. Infra ports are yaac's own control
 * surface and are never declarable, detectable or dialable. Sensitive ports
 * are only kept out of one-click detection: forwarding a dev database is an
 * explicit, ordinary thing to write in a config.
 */

/** Well-known ports never offered for one-click exposure — doing so is a
 *  step toward RCE (node --inspect) or data exposure (DBs). */
export const SENSITIVE_PORTS: ReadonlySet<number> = new Set([
  22, // sshd
  2375, 2376, // docker daemon
  3306, // mysql
  5432, // postgres
  6379, // redis
  9229, 9230, // node --inspect
  11211, // memcached
  27017, // mongodb
])

/** yaac's own in-workspace infra range (the pod driver's stream daemon on
 *  10300, its relay on 10260, …). */
const INFRA_PORT_MIN = 10250
const INFRA_PORT_MAX = 10350

/** Whether a port is yaac's own control surface — never the project's to
 *  forward, by config, detection or dial. */
export function isInfraPort(port: number): boolean {
  return port >= INFRA_PORT_MIN && port <= INFRA_PORT_MAX
}

/** Cap on ports surfaced per workspace — a hostile listener flood shows a
 *  bounded badge, not an unbounded snapshot. */
export const MAX_SURFACED_PORTS = 10

/** Whether a detected port may be offered at all. */
export function isForwardablePort(port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (SENSITIVE_PORTS.has(port)) return false
  return !isInfraPort(port)
}
