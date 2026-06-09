import { type JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MoreIcon, RestartIcon } from '@/frontend/lib/icons'
import { restartSession } from '@/frontend/lib/createSession'
import { useUiStore } from '@/frontend/store'

const ITEM = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none'

/**
 * Per-session header actions. Restart (kill + resume) only — delete lives on
 * the sidebar row's hover × (a single, optimistic delete path).
 */
export function SessionActionsMenu({ sessionId }: { sessionId: string }): JSX.Element {
  const reconnectTerminal = useUiStore((s) => s.reconnectTerminal)

  const onRestart = (): void => {
    void restartSession(sessionId, () => {})
      .then(() => reconnectTerminal(sessionId))
      .catch((e: unknown) => console.error('restart failed', e))
  }

  return (
    <Menu.Root>
      <Menu.Trigger className="flex h-6 w-6 items-center justify-center rounded text-text-dim transition
        hover:bg-surface-2 hover:text-text">
        <MoreIcon size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6}>
          <Menu.Popup className="min-w-[160px] rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <Menu.Item
              className={clsx(ITEM, 'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text')}
              onClick={onRestart}
            >
              <RestartIcon size={14} />
              Restart
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
