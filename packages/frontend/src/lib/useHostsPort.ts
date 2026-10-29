import { useEffect, useState } from 'react'
import { windowApi } from '#lib/platform'

/**
 * The port this machine routes workspace hostnames at
 * (docs/workspace-hostnames.md), or null where nothing the page knows of
 * does. A page from a server on loopback has the server's own port; the
 * desktop app against a remote server routes them itself and says where.
 */
export function useHostsPort(): number | null {
  const [routed, setRouted] = useState<number | null>(null)
  useEffect(() => windowApi()?.onHostsPort?.(setRouted), [])
  const { hostname, port, protocol } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return Number(port || (protocol === 'https:' ? 443 : 80))
  }
  return routed
}
