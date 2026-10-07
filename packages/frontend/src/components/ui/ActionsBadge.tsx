import { useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import { ChevronIcon, LoadingIcon } from '#lib/icons'
import { POPUP } from '#components/ui/menu'

export interface BadgeAction {
  label: string
  run: () => Promise<unknown>
}

/**
 * A count badge whose popover lists items, each expanding to its actions
 * (an item with none is a plain row).
 * An action's error shows under its item; success collapses the item, and
 * the next snapshot drops it. The badge renders its own <button>, so inside
 * a clickable row mount it as an overlaid sibling, not nested in the row's
 * button.
 */
export function ActionsBadge<T extends string | number>({
  label,
  icon,
  className,
  header,
  items,
  itemLabel,
  actions,
}: {
  /** The trigger's text and accessible name, e.g. "2 blocked hosts". */
  label: string
  icon: ReactNode
  /** Colors, positioning and hover highlight for the trigger. */
  className: string
  header: ReactNode
  items: T[]
  itemLabel: (item: T) => string
  actions: (item: T) => BadgeAction[]
}): JSX.Element {
  const [expanded, setExpanded] = useState<T | null>(null)
  const act = useMutation({
    mutationFn: (a: { item: T; run: () => Promise<unknown> }) => a.run(),
    onSuccess: () => setExpanded(null),
  })
  const pending = act.isPending ? act.variables.item : null

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        className={clsx('flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs font-medium transition', className)}
      >
        {icon}
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className={clsx('max-w-xs', POPUP)}>
            {header}
            <ul className="max-h-64 overflow-y-auto">
              {items.map((item) => {
                const itemActions = actions(item)
                const isOpen = expanded === item && itemActions.length > 0
                const isPending = pending === item
                return (
                  <li key={item}>
                    <button
                      type="button"
                      disabled={isPending || itemActions.length === 0}
                      onClick={() => {
                        setExpanded(isOpen ? null : item)
                        // Clears a stale error; a running action keeps its spinner.
                        if (!act.isPending) act.reset()
                      }}
                      className="flex w-full items-center gap-1 rounded px-2 py-1 text-left outline-none
                        hover:bg-surface-3 disabled:cursor-default"
                    >
                      <span className="flex-1 truncate font-mono text-xs text-text-dim">{itemLabel(item)}</span>
                      {isPending
                        ? <LoadingIcon size={12} className="shrink-0 animate-spin text-text-faint" />
                        : itemActions.length > 0 && (
                          <ChevronIcon
                            size={12}
                            className={clsx('shrink-0 text-text-faint transition-transform', isOpen && 'rotate-90')}
                          />
                        )}
                    </button>
                    {isOpen && (
                      <div className="flex flex-col pb-1 pl-2">
                        {itemActions.map(({ label: actionLabel, run }) => (
                          <button
                            key={actionLabel}
                            type="button"
                            disabled={isPending}
                            onClick={() => act.mutate({ item, run })}
                            className="rounded px-2 py-1 text-left text-xs text-text-dim outline-none
                              hover:bg-surface-3 disabled:opacity-50"
                          >
                            {actionLabel}
                          </button>
                        ))}
                        {act.error && <div className="px-2 py-1 text-xs text-danger">{act.error.message}</div>}
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
