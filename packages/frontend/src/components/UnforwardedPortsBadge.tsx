import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { ChevronIcon, LoadingIcon, PortIcon } from '#lib/icons'
import { forwardDetectedPort, dismissDetectedPort } from '#lib/portsApi'

/**
 * Detected-port badge for servers listening inside the worktree that aren't
 * forwarded; clicking it opens a popover listing the ports. Each row expands
 * to three actions — forward for just this running worktree, forward
 * permanently for the project (persisted to yaac-config.json), or dismiss the
 * offer. The exposure host shown in the header is the server-reported bind
 * (`forwardBindHost` on the snapshot — YAAC_FORWARD_BIND), NOT the page
 * origin: this line is the informed-consent claim, and the page can be
 * reached by a different name than the forward binds (e.g. an SSH tunnel to
 * a server that binds its tailnet IP). Mirrors BlockedHostsBadge: renders its
 * own <button>, so inside clickable rows mount it as an overlaid sibling,
 * never nested in the row button.
 */
export function UnforwardedPortsBadge({
  ports,
  worktreeId,
  exposeHost,
  iconSize,
  className,
}: {
  ports: number[]
  /** The worktree the listeners were detected in — the target of the actions. */
  worktreeId: string
  /** The bind host forwards actually listen on (snapshot `forwardBindHost`). */
  exposeHost: string
  iconSize: number
  /** Positioning and the context-appropriate hover highlight for the trigger. */
  className?: string
}): JSX.Element {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  // Rendered under the expanded row only, and cleared on any row toggle.
  const [error, setError] = useState<string | null>(null)

  async function act(port: number, action: () => Promise<void>): Promise<void> {
    setPending(port)
    setError(null)
    try {
      await action()
      // The server pushes a fresh snapshot that drops the handled port, so
      // the row disappears on its own; just collapse it in the meantime.
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
        aria-label={`${ports.length} detected port${ports.length === 1 ? '' : 's'}`}
        className={clsx(
          'flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1 py-0.5 text-xs font-medium text-text-dim transition',
          className,
        )}
      >
        <PortIcon size={iconSize} />
        {ports.length} detected port{ports.length === 1 ? '' : 's'}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="max-w-xs rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium text-text-faint">Detected ports</div>
            <div className="px-2 pb-1 text-[11px] text-text-faint">
              Servers listening in the worktree. Forwarding exposes them at
              {' '}
              <span className="font-mono">
                http://{exposeHost === '127.0.0.1' || exposeHost === '::1' ? 'localhost' : exposeHost}
              </span>
              {exposeHost === '127.0.0.1' || exposeHost === '::1'
                ? ' (this machine only)'
                : ' (reachable by anything that can reach that address)'}
              .
            </div>
            <ul className="max-h-64 overflow-y-auto">
              {ports.map((port) => {
                const isOpen = expanded === port
                const isPending = pending === port
                return (
                  <li key={port}>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => { setExpanded(isOpen ? null : port); setError(null) }}
                      className="flex w-full items-center gap-1 rounded px-2 py-1 text-left outline-none
                        hover:bg-surface-3 disabled:cursor-default"
                    >
                      <span className="flex-1 truncate font-mono text-xs text-text-dim">:{port}</span>
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
                          {
                            label: 'Forward for this worktree',
                            action: () => forwardDetectedPort(worktreeId, port, { persist: false }),
                          },
                          {
                            label: 'Forward permanently for this project',
                            action: () => forwardDetectedPort(worktreeId, port, { persist: true }),
                          },
                          {
                            label: 'Dismiss',
                            action: () => dismissDetectedPort(worktreeId, port),
                          },
                        ].map(({ label, action }) => (
                          <button
                            key={label}
                            type="button"
                            disabled={isPending}
                            onClick={() => void act(port, action)}
                            className="rounded px-2 py-1 text-left text-xs text-text-dim outline-none
                              hover:bg-surface-3 disabled:opacity-50"
                          >
                            {label}
                          </button>
                        ))}
                        {error && (
                          <div className="px-2 py-1 text-xs text-[#d65858]">{error}</div>
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
