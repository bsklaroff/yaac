import { useCallback } from 'react'
import { useUiStore } from '@/frontend/store'
import { formatUtcTimestamp } from '@/shared/time'
import type { AgentTool, ProvisioningSessionEntry } from '@/shared/types'

/** A streaming provision op (create or restart) for a known id. */
type ProvisionOp = (sessionId: string, onProgress: (message: string) => void) => Promise<{ sessionId: string }>

/**
 * Run a session provision (create, or restart-from-deleted) with the shared
 * optimistic flow: drop an immediate provisioning row (sidebar + selectable),
 * auto-open it so the creator watches progress in the main pane, and stream
 * progress/error into it until the server snapshot takes over (App prunes the
 * optimistic copy once its `provisioning[]` or `sessions[]` includes the id).
 */
export function useProvisionSession(): (
  projectSlug: string,
  tool: AgentTool,
  kind: ProvisioningSessionEntry['kind'],
  sessionId: string,
  op: ProvisionOp,
) => void {
  const addOptimisticProvisioning = useUiStore((s) => s.addOptimisticProvisioning)
  const updateOptimisticProvisioning = useUiStore((s) => s.updateOptimisticProvisioning)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const openSession = useUiStore((s) => s.openSession)

  return useCallback((projectSlug, tool, kind, sessionId, op) => {
    addOptimisticProvisioning({ sessionId, projectSlug, tool, kind, message: 'Starting…', createdAt: formatUtcTimestamp(Date.now()) })
    openSession(projectSlug, sessionId) // auto-open the locally-initiated provision
    void op(sessionId, (message) => updateOptimisticProvisioning(sessionId, { message }))
      .then((res) => {
        // A create that claimed a prewarmed spare returns the spare's own id,
        // not the one we generated (a running pod's id can't be re-keyed).
        // Re-key the optimistic row to that id and follow it — DON'T just drop
        // the row: the spare isn't in the snapshot yet, so for the gap until it
        // lands an unprotected selection would be stolen back to an existing
        // session by App's auto-select. Carrying an optimistic row keeps the
        // pane on the new session until the snapshot takes over.
        if (res.sessionId !== sessionId) {
          addOptimisticProvisioning({
            sessionId: res.sessionId, projectSlug, tool, kind, message: 'Claiming warm spare…', createdAt: formatUtcTimestamp(Date.now()),
          })
          removeOptimisticProvisioning(sessionId)
          openSession(projectSlug, res.sessionId)
        }
      })
      .catch((e: unknown) => {
        updateOptimisticProvisioning(sessionId, { error: e instanceof Error ? e.message : 'failed' })
      })
  }, [addOptimisticProvisioning, updateOptimisticProvisioning, removeOptimisticProvisioning, openSession])
}
