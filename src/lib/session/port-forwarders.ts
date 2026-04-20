/**
 * Process-local registry of port-forwarder stop functions keyed by
 * sessionId. The daemon creates forwarders when a session starts
 * (see `createSession`) and must tear them down when the session is
 * deleted or reaped; this module is the handoff point.
 *
 * Concurrent attaches to the same session share a single forwarder
 * set — register only the first one, and let re-registration for a
 * sessionId that already has forwarders be a no-op so
 * prewarm-claim paths can't double-register.
 */

const forwarders = new Map<string, () => void>()

export function registerSessionForwarders(sessionId: string, stop: () => void): void {
  if (forwarders.has(sessionId)) {
    // Already have forwarders for this session; drop the new ones to
    // avoid leaking handles.
    stop()
    return
  }
  forwarders.set(sessionId, stop)
}

export function stopSessionForwarders(sessionId: string): void {
  const stop = forwarders.get(sessionId)
  if (!stop) return
  forwarders.delete(sessionId)
  try {
    stop()
  } catch {
    // Best-effort teardown — a wedged forwarder shouldn't block delete.
  }
}
