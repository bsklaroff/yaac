/**
 * Which of a workspace's listening ports may be surfaced to the user at
 * all, and how many.
 *
 * Policy rather than mechanism, which is why it is here: HOW a driver
 * discovers a workspace's listeners is entirely its own (a stream daemon
 * pushing `/proc/net/tcp` from inside a pod, an `lsof` over a host process
 * tree), but WHAT is safe to offer is the same question either way. Fail
 * closed on both counts — a port that reaches this list is one click from
 * being reachable.
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
 *  10300, its relay on 10260, …) — anything here is hidden, not surfaced. */
const INFRA_PORT_MIN = 10250
const INFRA_PORT_MAX = 10350

/** Cap on ports surfaced per worktree — a hostile listener flood shows a
 *  bounded badge, not an unbounded snapshot. */
export const MAX_SURFACED_PORTS = 10

/** Whether a detected port may be offered at all. */
export function isForwardablePort(port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (SENSITIVE_PORTS.has(port)) return false
  if (port >= INFRA_PORT_MIN && port <= INFRA_PORT_MAX) return false
  return true
}
