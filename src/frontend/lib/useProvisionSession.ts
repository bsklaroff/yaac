import { useCallback } from 'react'
import { useUiStore } from '@/frontend/store'
import type { AgentTool } from '@/shared/types'

/** A streaming provision op (create or restart) that resolves with the id. */
type ProvisionOp = (onProgress: (message: string) => void) => Promise<{ sessionId: string }>

/**
 * Run a session provision (create, or restart-from-deleted) with the shared
 * optimistic flow: show the `creating` placeholder immediately (sidebar
 * "starting" row + main pane), keep it until the session lands in the
 * snapshot (App clears it), and select it so it opens the moment it's ready.
 */
export function useProvisionSession(): (projectSlug: string, tool: AgentTool, op: ProvisionOp) => void {
  const setCreating = useUiStore((s) => s.setCreating)
  const openSession = useUiStore((s) => s.openSession)

  return useCallback((projectSlug, tool, op) => {
    setCreating({ projectSlug, tool, message: 'Starting…' })
    void op((message) => setCreating({ projectSlug, tool, message }))
      .then((result) => {
        setCreating({ projectSlug, tool, message: 'Ready', sessionId: result.sessionId })
        openSession(projectSlug, result.sessionId)
      })
      .catch((e: unknown) => {
        setCreating({ projectSlug, tool, message: '', error: e instanceof Error ? e.message : 'failed' })
      })
  }, [setCreating, openSession])
}
