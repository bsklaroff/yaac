import type { JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { BlockedIcon } from '@/frontend/lib/icons'

/**
 * Blocked-host count badge; clicking it opens a popover listing the hosts.
 * Renders its own <button>, so inside clickable rows mount it as an overlaid
 * sibling (like the sidebar's delete ×), never nested in the row button.
 */
export function BlockedHostsBadge({
  hosts,
  iconSize,
  className,
}: {
  hosts: string[]
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`${hosts.length} blocked host(s)`}
        className={clsx(
          'flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-xs text-[#d65858] transition',
          className,
        )}
      >
        <BlockedIcon size={iconSize} />
        {hosts.length}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="max-w-xs rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-text-faint">Blocked hosts</div>
            <ul className="max-h-64 overflow-y-auto">
              {hosts.map((host) => (
                <li key={host} className="truncate px-2 py-1 font-mono text-xs text-text-dim">
                  {host}
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
