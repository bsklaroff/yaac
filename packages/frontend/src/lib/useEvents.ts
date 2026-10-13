import { useEffect, useState } from 'react'
import type { ServerEvent } from '@yaac/shared/types'
import { reconnectingSocket } from '#lib/reconnect'
import { useUiStore } from '#lib/store'

/**
 * Subscribe to the server's `/events` WebSocket and hand each `snapshot`
 * frame to the store (`receiveSnapshot`). See `reconnectingSocket` for the
 * reconnect policy. Returns whether the socket is connected.
 */
export function useEvents(enabled: boolean): { connected: boolean } {
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
        useUiStore.getState().receiveSnapshot(parsed.data)
        return true
      },
      close: () => setConnected(false),
    })
    return () => sock.close()
  }, [enabled])

  return { connected }
}
