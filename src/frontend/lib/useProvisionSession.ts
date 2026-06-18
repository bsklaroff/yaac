import { useCallback } from 'react'
import { useUiStore } from '@/frontend/store'
import type { AgentTool, ProvisioningSessionEntry } from '@/shared/types'

/** A streaming provision op (create or restart) for a known id. */
type ProvisionOp = (sessionId: string, onProgress: (message: string) => void) => Promise<{ sessionId: string }>

/** Now as 'YYYY-MM-DD HH:MM:SS' UTC — matches the daemon's createdAt shape so
 *  the optimistic row sorts and ages like a snapshot-driven one. */
function nowUtc(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Run a session provision (create, or restart-from-deleted) with the shared
 * optimistic flow: drop an immediate provisioning row (sidebar + selectable),
 * auto-open it so the creator watches progress in the main pane, and stream
 * progress/error into it until the daemon snapshot takes over (App prunes the
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
  const openSession = useUiStore((s) => s.openSession)

  return useCallback((projectSlug, tool, kind, sessionId, op) => {
    addOptimisticProvisioning({ sessionId, projectSlug, tool, kind, message: 'Starting…', createdAt: nowUtc() })
    openSession(projectSlug, sessionId) // auto-open the locally-initiated provision
    void op(sessionId, (message) => updateOptimisticProvisioning(sessionId, { message }))
      .catch((e: unknown) => {
        updateOptimisticProvisioning(sessionId, { error: e instanceof Error ? e.message : 'failed' })
      })
  }, [addOptimisticProvisioning, updateOptimisticProvisioning, openSession])
}
