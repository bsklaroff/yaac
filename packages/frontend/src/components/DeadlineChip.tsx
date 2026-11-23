import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import clsx from 'clsx'
import { api } from '#lib/api'
import { ChevronIcon, TimeoutIcon } from '#lib/icons'
import { timeUntil, useNow } from '#lib/time'
import { minutesUntil, parseDuration } from '@yaac/shared/schedule'
import { MENU_ITEM, YChip, YInput, YMenu, YMenuItem, YMenuLabel, YMenuPopup } from '#ui'

/** A workspace's timeout (docs/routines.md "Timeouts"), shared by the bar's
 *  chip and the ⋯ menu's Set a timeout: the menu items that change it (one
 *  `clears` it), the custom duration box (`custom`: null while closed), why
 *  the last change failed, and the ⋯ button (`menuButton`), where focus goes
 *  when the chip it would return to is gone. */
export interface WorkspaceTimeout {
  deadline: string | undefined
  items: { label: string; onClick: () => void; clears?: true }[]
  set: (timeout: number | null) => void
  custom: string | null
  setCustom: (custom: string | null) => void
  error: string | null
  menuButton: RefObject<HTMLButtonElement | null>
}

/**
 * The items push the deadline back, set one, or clear it. The server takes
 * a timeout as minutes from now, so "+30m" sends the minutes from now until
 * half an hour past the current deadline.
 */
export function useWorkspaceTimeout(workspaceId: string, deadline: string | undefined): WorkspaceTimeout {
  const [custom, setCustom] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  // The workspace view keeps one of these across the workspaces it shows.
  useEffect(() => { setCustom(null); setError(null) }, [workspaceId])
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
    // After the click is done, so the menu's own focus handling for the
    // item cannot blur the box as it opens.
    { label: 'Stop after…', onClick: () => { setTimeout(() => setCustom(''), 0) } },
    ...(deadline !== undefined ? [{ label: 'No timeout', onClick: () => set(null), clears: true as const }] : []),
  ]
  return { deadline, items, set, custom, setCustom, error, menuButton }
}

/**
 * The workspace bar's timeout chip, "stops in 42m", whose menu changes it.
 * A phone's bar has no room for the words, so there the menu says them.
 * With no deadline it shows only while its duration box is open or its
 * last change failed; otherwise Set a timeout lives in the ⋯ menu. A box
 * closed from the keyboard hands focus to the chip, or to ⋯ when no chip
 * remains, and so does clearing the deadline.
 */
export function DeadlineChip({ timeout }: { timeout: WorkspaceTimeout }): JSX.Element | null {
  const now = useNow()
  const { deadline, items, set, custom, setCustom, error, menuButton } = timeout
  const chip = useRef<HTMLButtonElement>(null)
  // Set by Enter or Escape in the box, and acted on once it has closed.
  const refocus = useRef(false)
  const cleared = useRef(false)
  useEffect(() => {
    if (!refocus.current || custom !== null) return
    refocus.current = false
    ;(chip.current ?? menuButton.current)?.focus()
  })
  if (custom !== null) {
    const minutes = parseDuration(custom)
    return (
      <YInput
        autoFocus
        aria-label="Stop after"
        value={custom}
        placeholder="1h30m"
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          // Focus moves to a button during this keydown, so the key's
          // default action would press that button and open its menu.
          if (e.key === 'Escape') {
            e.preventDefault()
            refocus.current = true
            setCustom(null)
          }
          if (e.key !== 'Enter' || minutes === undefined) return
          e.preventDefault()
          refocus.current = true
          setCustom(null)
          set(minutes)
        }}
        onBlur={() => setCustom(null)}
        className={clsx('no-drag w-20 shrink-0', custom !== '' && minutes === undefined && 'focus-visible:outline-danger')}
      />
    )
  }
  if (deadline === undefined && error === null) return null
  return (
    <YMenu.Root onOpenChange={(open) => { if (open) cleared.current = false }}>
      <YMenu.Trigger
        render={(
          <YChip
            ref={chip}
            icon={TimeoutIcon}
            title={error ?? 'Change when the server stops it'}
            aria-label={deadline !== undefined ? `Stops in ${timeUntil(deadline, now)}` : 'Set a timeout'}
            className={clsx('no-drag font-normal', deadline === undefined ? 'px-1.5' : 'max-md:px-1.5', error !== null && 'text-danger')}
          >
            {deadline !== undefined && <span className="max-md:hidden">stops in {timeUntil(deadline, now)}</span>}
          </YChip>
        )}
      />
      <YMenuPopup
        side="bottom"
        align="end"
        sideOffset={4}
        className="min-w-[140px]"
        finalFocus={() => (cleared.current ? menuButton.current ?? true : true)}
      >
        {deadline !== undefined && <YMenuLabel className="md:hidden">Stops in {timeUntil(deadline, now)}</YMenuLabel>}
        {items.map((item) => (
          <YMenuItem key={item.label} onClick={() => { cleared.current = item.clears === true; item.onClick() }}>{item.label}</YMenuItem>
        ))}
      </YMenuPopup>
    </YMenu.Root>
  )
}

/** The ⋯ menu's Set a timeout, for a workspace with none. */
export function TimeoutSubmenu({ timeout }: { timeout: WorkspaceTimeout }): JSX.Element {
  return (
    <YMenu.SubmenuRoot>
      <YMenu.SubmenuTrigger className={clsx(MENU_ITEM, 'data-[popup-open]:bg-hover')}>
        <TimeoutIcon size={14} strokeWidth={1.75} aria-hidden />
        <span className="flex-1">Set a timeout</span>
        <ChevronIcon size={12} strokeWidth={2} aria-hidden className="text-subtle" />
      </YMenu.SubmenuTrigger>
      <YMenuPopup side="left" align="start" className="min-w-[140px]">
        {timeout.items.map((item) => (
          <YMenuItem key={item.label} onClick={item.onClick}>{item.label}</YMenuItem>
        ))}
      </YMenuPopup>
    </YMenu.SubmenuRoot>
  )
}
