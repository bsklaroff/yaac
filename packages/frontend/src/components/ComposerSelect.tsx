import type { JSX, ReactNode } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MENU_ITEM, MenuPopup } from '#components/ui/menu'
import { CheckIcon, ChevronIcon } from '#lib/icons'
import { useSnapshot } from '#lib/useSnapshot'
import { effortLabel, PERMISSION_MODE_COPY, type PermissionMode } from '@yaac/shared/types'

/*
 * The chat composer's per-conversation settings: its permission posture
 * (docs/permission-modes.md) and its effort level (docs/effort-levels.md).
 * Each is a label showing the current value, which opens a menu of the
 * values the server says the conversation can switch to. A narrow pane
 * drops the label's last word so the composer's footer fits on one line.
 */

/** What each posture lets the agent do, for hover text and the menu. */
export const PERMISSION_MODE_HELP: Record<PermissionMode, string> = {
  bypass: 'The agent acts without ever asking.',
  auto: 'The agent acts without asking, but a reviewer model judges each action'
    + ' and blocks the dangerous ones. Claude gates this by subscription plan.',
  'accept-edits': 'The agent edits files in the workspace without asking, and still'
    + ' asks before running commands or reaching outside it.',
  manual: 'The agent asks before every action.',
  plan: 'The agent explores and plans read-only; it cannot edit until you approve a plan.',
  'read-only': 'The agent reads and explores freely inside a read-only sandbox, and asks before'
    + ' every edit and anything that reaches the network.',
}

const LABEL = 'flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs text-text-faint'

/** A setting's menu. An item's `detail` goes on lines under its name. */
function ComposerSelect<T extends string>({ name, title, label, width, current, items, disabled, onSelect }: {
  /** The trigger's accessible name. */
  name: string
  title: string
  label: ReactNode
  width: string
  current: T
  items: ReadonlyArray<{ value: T; name: string; detail?: ReactNode }>
  disabled: boolean
  onSelect: (value: T) => void
}): JSX.Element {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={name}
        title={title}
        disabled={disabled}
        className={clsx(LABEL, 'outline-none hover:bg-surface-2 hover:text-text disabled:opacity-40',
          'data-[popup-open]:bg-surface-2 data-[popup-open]:text-text')}
      >
        {label}
        <ChevronIcon size={11} className="-rotate-90" />
      </Menu.Trigger>
      <MenuPopup side="top" align="start" sideOffset={6} className={width}>
        <Menu.RadioGroup value={current} onValueChange={(value: T) => onSelect(value)}>
          {items.map((item) => (
            <Menu.RadioItem key={item.value} value={item.value} closeOnClick className={clsx(MENU_ITEM, 'items-start')}>
              <span className="mt-0.5 w-3 shrink-0">
                <Menu.RadioItemIndicator><CheckIcon size={12} /></Menu.RadioItemIndicator>
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-text">{item.name}</span>
                {item.detail}
              </span>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </MenuPopup>
    </Menu.Root>
  )
}

/** A label whose `tail` shows only in a wide enough pane. */
function Label({ head, tail }: { head: string; tail?: string }): JSX.Element {
  return <span>{head}{tail && <span className="hidden @min-[30rem]:inline"> {tail}</span>}</span>
}

/**
 * The conversation's permission posture. Where it can't be switched
 * (opencode, pi) the label is plain text. Under containerless, `bypass`
 * carries the create form's warning, since there the agent then acts as the
 * user on this machine.
 */
export function PermissionModeSelect({ current, available, disabled, onSelect }: {
  current: PermissionMode
  available: readonly PermissionMode[]
  disabled: boolean
  onSelect: (mode: PermissionMode) => void
}): JSX.Element {
  const containerless = useSnapshot()?.driver === 'containerless'
  const copy = PERMISSION_MODE_COPY[current]
  const short = copy.replace(/ permissions$/, '')
  const label = <Label head={short} {...(short !== copy ? { tail: 'permissions' } : {})} />
  if (available.length === 0) return <span className={LABEL} title={PERMISSION_MODE_HELP[current]}>{label}</span>
  return (
    <ComposerSelect
      name="Permission mode"
      title={PERMISSION_MODE_HELP[current]}
      label={label}
      width="w-[280px]"
      current={current}
      items={available.map((m) => ({
        value: m,
        name: PERMISSION_MODE_COPY[m],
        detail: (
          <>
            <span className="text-[11px] text-text-faint">{PERMISSION_MODE_HELP[m]}</span>
            {m === 'bypass' && containerless && (
              <span className="text-[11px] text-warning">No sandbox — acts as you.</span>
            )}
          </>
        ),
      }))}
      disabled={disabled}
      onSelect={onSelect}
    />
  )
}

/** The conversation's effort level, from the levels its current model
 *  offers. The names are the agent's own, so they follow a model switch. */
export function EffortSelect({ current, available, disabled, onSelect }: {
  current: string
  available: ReadonlyArray<{ value: string; name: string }>
  disabled: boolean
  onSelect: (effort: string) => void
}): JSX.Element {
  const head = available.find((o) => o.value === current)?.name ?? effortLabel(current)
  return (
    <ComposerSelect
      name="Effort"
      title="How hard the model thinks"
      label={<Label head={head} tail="effort" />}
      width="w-[180px]"
      current={current}
      items={available}
      disabled={disabled}
      onSelect={onSelect}
    />
  )
}
