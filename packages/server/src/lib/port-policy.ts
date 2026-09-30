/**
 * Which of a workspace's listening ports may be shown to the user, how many,
 * and which may never be forwarded. How ports are discovered is up to each
 * driver; this policy is shared by both drivers and config validation.
 * It fails closed, since a listed port is one click from being reachable.
 *
 * Infra ports are yaac's own control surface and can never be declared,
 * detected or dialed. Sensitive ports are only excluded from one-click
 * detection; a config may still forward them explicitly.
 */

/** Well-known ports never offered for one-click exposure, since that risks
 *  RCE (node --inspect) or data exposure (databases). */
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

/** Whether a port is yaac's own; never forwardable by config, detection or
 *  dial. */
export function isInfraPort(port: number): boolean {
  return port >= INFRA_PORT_MIN && port <= INFRA_PORT_MAX
}

/** Cap on ports shown per workspace, so a flood of listeners stays
 *  bounded. */
export const MAX_SURFACED_PORTS = 10

/** Whether a detected port may be offered at all. */
export function isForwardablePort(port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (SENSITIVE_PORTS.has(port)) return false
  return !isInfraPort(port)
}
