import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MENU_ITEM, MenuPopup } from '#components/ui/menu'
import { api } from '#lib/api'
import { TimeoutIcon } from '#lib/icons'
import { timeUntil, useNow } from '#lib/time'
import { minutesUntil, parseDuration } from '@yaac/shared/schedule'

/**
 * The workspace header's timeout control (docs/routines.md "Timeouts"):
 * "stops in 42m" while the workspace has a deadline, else a bare clock. Its
 * menu pushes the deadline back, sets one, or clears it. The server takes a
 * timeout as minutes from now, so "+30m" sends the minutes from now until
 * half an hour past the current deadline.
 */
export function DeadlineChip({ workspaceId, deadline }: { workspaceId: string; deadline?: string }): JSX.Element {
  const now = useNow()
  // null = the chip; a string = the custom duration box.
  const [custom, setCustom] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const set = (timeout: number | null): void => {
    setError(null)
    api.workspace.timeout.$post({ json: { workspaceId, timeout } })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const extend = (minutes: number): void => {
    const from = deadline !== undefined ? Date.parse(deadline) : Date.now()
    set(Math.max(1, minutesUntil(new Date(from + minutes * 60_000), new Date())))
  }
  const items = [
    { label: deadline !== undefined ? '+30m' : 'Stop in 30m', onClick: () => extend(30) },
    { label: deadline !== undefined ? '+2h' : 'Stop in 2h', onClick: () => extend(120) },
    { label: 'Stop after…', onClick: () => setCustom('') },
    ...(deadline !== undefined ? [{ label: 'No timeout', onClick: () => set(null) }] : []),
  ]

  if (custom !== null) {
    const minutes = parseDuration(custom)
    return (
      <input
        autoFocus
        aria-label="Stop after"
        value={custom}
        placeholder="1h30m"
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setCustom(null)
          if (e.key !== 'Enter' || minutes === undefined) return
          setCustom(null)
          set(minutes)
        }}
        onBlur={() => setCustom(null)}
        className={clsx('no-drag h-6 w-20 shrink-0 rounded border bg-bg px-1.5 text-[11px] text-text outline-none',
          custom !== '' && minutes === undefined ? 'border-danger' : 'border-border-strong')}
      />
    )
  }
  return (
    <Menu.Root>
      <Menu.Trigger
        title={error ?? (deadline !== undefined ? 'Change when the server stops it' : 'Set a timeout')}
        aria-label={deadline !== undefined ? `Stops in ${timeUntil(deadline, now)}` : 'Set a timeout'}
        className={clsx('no-drag flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] transition',
          'hover:bg-surface-2 data-[popup-open]:bg-surface-2', error !== null ? 'text-danger' : 'text-text-dim')}
      >
        <TimeoutIcon size={11} />
        {deadline !== undefined && <span className="whitespace-nowrap">stops in {timeUntil(deadline, now)}</span>}
      </Menu.Trigger>
      <MenuPopup side="bottom" align="end" sideOffset={4} className="min-w-[140px]">
        {items.map((item) => (
          <Menu.Item key={item.label} className={MENU_ITEM} onClick={item.onClick}>{item.label}</Menu.Item>
        ))}
      </MenuPopup>
    </Menu.Root>
  )
}
