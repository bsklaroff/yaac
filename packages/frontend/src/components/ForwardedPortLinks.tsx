import type { JSX } from 'react'
import clsx from 'clsx'
import { CloseIcon, OpenLinkIcon } from '#lib/icons'
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

/**
 * The × that stops forwarding a port, shown while its `group` parent (the
 * port's chip, Preview button or menu row) is hovered or highlighted. It
 * keeps its click from the parent, so stopping a port never also opens it.
 */
export function StopForwardButton({
  containerPort,
  iconSize,
  onStop,
}: {
  containerPort: number
  iconSize: number
  onStop: (containerPort: number) => void
}): JSX.Element {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onStop(containerPort) }}
      onMouseUp={(e) => e.stopPropagation()}
      title={`Stop forwarding port ${containerPort}`}
      aria-label={`Stop forwarding port ${containerPort}`}
      className="-ml-0.5 mr-0.5 flex items-center text-text-faint opacity-0 transition
        hover:text-text focus-visible:opacity-100 group-hover:opacity-100
        group-data-[highlighted]:opacity-100"
    >
      <CloseIcon size={iconSize - 2} />
    </button>
  )
}

/**
 * External-link chips for a workspace's forwarded ports. With `onStop`,
 * each chip also has a stop-forwarding button, shown on hover.
 */
export function ForwardedPortLinks({
  ports,
  iconSize,
  className,
  onStop,
}: {
  ports: PortMapping[]
  iconSize: number
  /** Context-appropriate hover highlight for the chips. */
  className?: string
  /** Stop forwarding a port; omitted where there is no forward to stop. */
  onStop?: (containerPort: number) => void
}): JSX.Element {
  return (
    <>
      {ports.map((p) => (
        <span
          key={`${p.hostPort}:${p.containerPort}`}
          className={clsx('group flex shrink-0 items-center rounded transition', className)}
        >
          <a
            href={portLinkHref(window.location.hostname, p)}
            target="_blank"
            rel="noreferrer"
            title={`Open ${window.location.hostname}:${p.hostPort} (container port ${p.containerPort})`}
            className="flex items-center gap-1 px-1 py-0.5 font-mono text-[11px] text-text-dim transition
              hover:text-text"
          >
            <OpenLinkIcon size={iconSize} />
            {portLinkLabel(p)}
          </a>
          {onStop && <StopForwardButton containerPort={p.containerPort} iconSize={iconSize} onStop={onStop} />}
        </span>
      ))}
    </>
  )
}
