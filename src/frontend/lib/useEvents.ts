import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ServerEvent } from '@/shared/types'
import { INITIAL_RECONNECT_DELAY_MS, nextReconnectDelay } from '@/frontend/lib/reconnect'

export const SNAPSHOT_KEY = ['snapshot'] as const

/**
 * Subscribe to the server's `/events` WebSocket and hydrate the React
 * Query cache from each `snapshot` frame. Same-origin, so the session
 * cookie rides the upgrade automatically. Reconnects with exponential
 * backoff (500ms → 10s cap). Returns whether the socket is connected.
 */
export function useEvents(enabled: boolean): { connected: boolean } {
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(false)
  const backoffRef = useRef(INITIAL_RECONNECT_DELAY_MS)

  useEffect(() => {
    if (!enabled) return
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let closedByUs = false

    const connect = (): void => {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${scheme}://${window.location.host}/events`)

      ws.onopen = (): void => {
        setConnected(true)
        backoffRef.current = INITIAL_RECONNECT_DELAY_MS
      }

      ws.onmessage = (evt: MessageEvent): void => {
        if (typeof evt.data !== 'string') return
        let parsed: ServerEvent
        try {
          parsed = JSON.parse(evt.data) as ServerEvent
        } catch {
          return
        }
        if (parsed.type === 'snapshot') {
          queryClient.setQueryData(SNAPSHOT_KEY, parsed.data)
        }
      }

      ws.onerror = (): void => ws?.close()

      ws.onclose = (): void => {
        setConnected(false)
        if (closedByUs) return
        reconnectTimer = setTimeout(connect, backoffRef.current)
        backoffRef.current = nextReconnectDelay(backoffRef.current)
      }
    }

    connect()

    return (): void => {
      closedByUs = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [enabled, queryClient])

  return { connected }
}
