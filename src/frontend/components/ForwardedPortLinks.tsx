import type { JSX } from 'react'
import clsx from 'clsx'
import { OpenLinkIcon } from '@/frontend/lib/icons'
import type { PortMapping } from '@/shared/types'

/**
 * Chip label for one forwarded port. The host port leads — it is the
 * localhost URL the chip opens — with the container port appended when
 * it differs, so the in-container server ("my dev server on 8787")
 * stays recognizable.
 */
export function portLinkLabel(p: PortMapping): string {
  return p.hostPort === p.containerPort
    ? `:${p.hostPort}`
    : `:${p.hostPort}→${p.containerPort}`
}

/**
 * One link chip per forwarded port; clicking opens
 * `http://localhost:<hostPort>` in a new tab. This is the webapp's
 * replacement for the tmux status-right port readout — webapp panes
 * attach through view sessions with `status off`, so the daemon-pushed
 * snapshot is the only place the mapping can surface.
 */
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
          href={`http://localhost:${p.hostPort}`}
          target="_blank"
          rel="noreferrer"
          title={`Open localhost:${p.hostPort} (container port ${p.containerPort})`}
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
