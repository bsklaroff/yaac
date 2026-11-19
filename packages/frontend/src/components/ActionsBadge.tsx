import { useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation } from '@tanstack/react-query'
import { ChevronIcon, LoadingIcon } from '#lib/icons'
import { YButton, YPopover, YPopoverPopup } from '#ui'

/** A badge's popover trigger: YBadge's shape, which the caller tints
 *  (`bg-warning-soft text-warning`). */
export const BADGE_TRIGGER = 'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-xs '
  + 'font-medium outline-none transition focus-visible:outline-2 focus-visible:outline-accent'

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
    <YPopover.Root>
      <YPopover.Trigger aria-label={label} className={clsx(BADGE_TRIGGER, className)}>
        {icon}
        {label}
      </YPopover.Trigger>
      <YPopoverPopup side="bottom" align="end" sideOffset={4} className="max-w-xs">
        {header}
        <ul className="max-h-64 overflow-y-auto">
          {items.map((item) => {
            const itemActions = actions(item)
            const isOpen = expanded === item && itemActions.length > 0
            const isPending = pending === item
            return (
              <li key={item}>
                <YButton
                  variant="bare"
                  disabled={isPending || itemActions.length === 0}
                  onClick={() => {
                    setExpanded(isOpen ? null : item)
                    // Clears a stale error; a running action keeps its spinner.
                    if (!act.isPending) act.reset()
                  }}
                  className="flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-line-strong
                    disabled:cursor-default disabled:opacity-100"
                >
                  <span className="flex-1 truncate font-mono text-md text-muted">{itemLabel(item)}</span>
                  {isPending
                    ? <LoadingIcon size={12} className="shrink-0 animate-spin text-subtle" />
                    : itemActions.length > 0 && (
                      <ChevronIcon
                        size={12}
                        className={clsx('shrink-0 text-subtle transition-transform', isOpen && 'rotate-90')}
                      />
                    )}
                </YButton>
                {isOpen && (
                  <div className="flex flex-col pb-1 pl-2">
                    {itemActions.map(({ label: actionLabel, run }) => (
                      <YButton
                        key={actionLabel}
                        variant="ghost"
                        disabled={isPending}
                        onClick={() => act.mutate({ item, run })}
                        className="justify-start"
                      >
                        {actionLabel}
                      </YButton>
                    ))}
                    {act.error && <div className="px-2 py-1 text-md text-danger">{act.error.message}</div>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </YPopoverPopup>
    </YPopover.Root>
  )
}
