import type { JSX } from 'react'
import clsx from 'clsx'
import { OpenLinkIcon } from '#lib/icons'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Chip label for a forwarded port: the host port the chip opens, plus the
 * container port when it differs.
 */
export function portLinkLabel(p: PortMapping): string {
  return p.hostPort === p.containerPort
    ? `:${p.hostPort}`
    : `:${p.hostPort}→${p.containerPort}`
}

/**
 * URL for a forwarded port on the host the webapp was loaded from. The
 * server binds no forwarded ports; a client forwarder does
 * (docs/port-forward-tunnel.md), so the link works only where one is
 * listening on that interface. The desktop preview pane uses loopback
 * instead (`#lib/preview`).
 */
export function portLinkHref(hostname: string, p: PortMapping): string {
  return `http://${hostname}:${p.hostPort}`
}

export function ForwardedPortLinks({
  ports,
  iconSize,
  className,
}: {
  ports: PortMapping[]
  iconSize: number
  /** Context-appropriate hover highlight for the chips. */
  className?: string
}): JSX.Element {
  return (
    <>
      {ports.map((p) => (
        <a
          key={`${p.hostPort}:${p.containerPort}`}
          href={portLinkHref(window.location.hostname, p)}
          target="_blank"
          rel="noreferrer"
          title={`Open ${window.location.hostname}:${p.hostPort} (container port ${p.containerPort})`}
          className={clsx(
            'flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-[11px]',
            'text-text-dim transition hover:text-text',
            className,
          )}
        >
          <OpenLinkIcon size={iconSize} />
          {portLinkLabel(p)}
        </a>
      ))}
    </>
  )
}
