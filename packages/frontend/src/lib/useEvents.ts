import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ServerEvent } from '@yaac/shared/types'
import { reconnectingSocket } from '#lib/reconnect'
import { useUiStore } from '#lib/store'

export const SNAPSHOT_KEY = ['snapshot'] as const

/**
 * Subscribe to the server's `/events` WebSocket and write each `snapshot`
 * frame into the React Query cache, first folding it into the store's
 * optimistic state (`reconcileSnapshot`). See `reconnectingSocket` for the
 * reconnect policy. Returns whether the socket is connected.
 */
export function useEvents(enabled: boolean): { connected: boolean } {
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const sock = reconnectingSocket(() => '/api/events', {
      open: () => setConnected(true),
      message: (data) => {
        if (typeof data !== 'string') return false
        let parsed: ServerEvent
        try {
          parsed = JSON.parse(data) as ServerEvent
        } catch {
          return false
        }
        if (parsed.type !== 'snapshot') return false
        useUiStore.getState().reconcileSnapshot(parsed.data)
        queryClient.setQueryData(SNAPSHOT_KEY, parsed.data)
        return true
      },
      close: () => setConnected(false),
    })
    return () => sock.close()
  }, [enabled, queryClient])

  return { connected }
}
