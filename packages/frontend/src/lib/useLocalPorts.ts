import { useEffect, useMemo, useState } from 'react'
import { windowApi } from '#lib/platform'
import type { LocalPortRemap, PortMapping } from '@yaac/shared/types'

/**
 * A workspace's forwarded ports as this machine reaches them. When another
 * process here holds a port the server offers, the desktop app forwards it
 * at the next free port instead (docs/port-forward-tunnel.md), and each
 * such mapping's `hostPort` is swapped for that one. In a browser the
 * server's ports are returned as they are.
 */
export function useLocalPorts(workspaceId: string | null, ports: PortMapping[]): PortMapping[] {
  const [remaps, setRemaps] = useState<LocalPortRemap[]>([])
  useEffect(() => windowApi()?.onForwardRemaps?.(setRemaps), [])
  return useMemo(() => ports.map((p) => {
    const remap = remaps.find((r) => r.workspaceId === workspaceId
      && r.containerPort === p.containerPort && r.hostPort === p.hostPort)
    return remap ? { containerPort: p.containerPort, hostPort: remap.localPort } : p
  }), [workspaceId, ports, remaps])
}
