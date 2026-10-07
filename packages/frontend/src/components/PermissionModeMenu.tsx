import type { JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { CheckIcon, ChevronIcon } from '#lib/icons'
import { useSnapshot } from '#lib/useSnapshot'
import { PERMISSION_MODE_COPY, type PermissionMode } from '@yaac/shared/types'

/**
 * The chat composer's permission posture (docs/permission-modes.md): a label
 * showing the posture the conversation is in, which opens a menu of the
 * ones it can be switched to. The server says which those are; where there
 * are none (opencode, pi) the label is plain text. Under containerless,
 * `bypass` carries the create form's warning, since there the agent then
 * acts as the user on this machine.
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

const LABEL = 'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-text-faint'

export function PermissionModeMenu({
  current,
  available,
  disabled,
  onSelect,
}: {
  current: PermissionMode
  available: readonly PermissionMode[]
  disabled: boolean
  onSelect: (mode: PermissionMode) => void
}): JSX.Element {
  const containerless = useSnapshot()?.driver === 'containerless'
  if (available.length === 0) {
    return <span className={LABEL} title={PERMISSION_MODE_HELP[current]}>{PERMISSION_MODE_COPY[current]}</span>
  }
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Permission mode"
        title={PERMISSION_MODE_HELP[current]}
        disabled={disabled}
        className={clsx(LABEL, 'outline-none hover:bg-surface-2 hover:text-text disabled:opacity-40',
          'data-[popup-open]:bg-surface-2 data-[popup-open]:text-text')}
      >
        {PERMISSION_MODE_COPY[current]}
        <ChevronIcon size={11} className="-rotate-90" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6}>
          <Menu.Popup className={clsx('w-[280px]', POPUP)}>
            <Menu.RadioGroup value={current} onValueChange={(mode: PermissionMode) => onSelect(mode)}>
              {available.map((m) => (
                <Menu.RadioItem key={m} value={m} closeOnClick className={clsx(MENU_ITEM, 'items-start')}>
                  <span className="mt-0.5 w-3 shrink-0">
                    <Menu.RadioItemIndicator><CheckIcon size={12} /></Menu.RadioItemIndicator>
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-text">{PERMISSION_MODE_COPY[m]}</span>
                    <span className="text-[11px] text-text-faint">{PERMISSION_MODE_HELP[m]}</span>
                    {m === 'bypass' && containerless && (
                      <span className="text-[11px] text-warning">No sandbox — acts as you.</span>
                    )}
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
