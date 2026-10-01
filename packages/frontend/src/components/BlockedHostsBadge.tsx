import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { BlockedIcon, ChevronIcon, LoadingIcon } from '#lib/icons'
import { allowBlockedHost } from '#lib/blockedHostsApi'

/**
 * Blocked-host count badge that opens a popover listing the hosts. Each host
 * can be allowed for this workspace or permanently for the project (saved to
 * yaac-config.json). Renders its own <button>, so inside a clickable row mount
 * it as an overlaid sibling, not nested in the row's button.
 */
export function BlockedHostsBadge({
  hosts,
  workspaceId,
  iconSize,
  className,
}: {
  hosts: string[]
  /** The workspace these hosts were blocked for. */
  workspaceId: string
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function allow(host: string, persist: boolean): Promise<void> {
    setPending(host)
    setError(null)
    try {
      await allowBlockedHost(workspaceId, host, { persist })
      // The next snapshot drops the allowed host from the list.
      setExpanded(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`${hosts.length} blocked host${hosts.length === 1 ? '' : 's'}`}
        className={clsx(
          'flex shrink-0 items-center gap-1 rounded bg-danger/15 px-1 py-0.5 text-xs font-medium text-danger transition',
          className,
        )}
      >
        <BlockedIcon size={iconSize} />
        {hosts.length} blocked host{hosts.length === 1 ? '' : 's'}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="max-w-xs rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-text-faint">Blocked hosts</div>
            <ul className="max-h-64 overflow-y-auto">
              {hosts.map((host) => {
                const isOpen = expanded === host
                const isPending = pending === host
                return (
                  <li key={host}>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => { setExpanded(isOpen ? null : host); setError(null) }}
                      className="flex w-full items-center gap-1 rounded px-2 py-1 text-left outline-none
                        hover:bg-surface-3 disabled:cursor-default"
                    >
                      <span className="flex-1 truncate font-mono text-xs text-text-dim">{host}</span>
                      {isPending
                        ? <LoadingIcon size={12} className="shrink-0 animate-spin text-text-faint" />
                        : (
                          <ChevronIcon
                            size={12}
                            className={clsx('shrink-0 text-text-faint transition-transform', isOpen && 'rotate-90')}
                          />
                        )}
                    </button>
                    {isOpen && (
                      <div className="flex flex-col pb-1 pl-2">
                        {[
                          { persist: false, label: 'Allow for this workspace' },
                          { persist: true, label: 'Allow permanently for this project' },
                        ].map(({ persist, label }) => (
                          <button
                            key={label}
                            type="button"
                            disabled={isPending}
                            onClick={() => void allow(host, persist)}
                            className="rounded px-2 py-1 text-left text-xs text-text-dim outline-none
                              hover:bg-surface-3 disabled:opacity-50"
                          >
                            {label}
                          </button>
                        ))}
                        {error && (
                          <div className="px-2 py-1 text-xs text-danger">{error}</div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
