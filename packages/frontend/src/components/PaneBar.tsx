import type { JSX } from 'react'
import clsx from 'clsx'
import { Menu } from '@base-ui/react/menu'
import { MENU_ITEM, MenuPopup } from '#components/ui/menu'
import {
  AddIcon, ChangesIcon, ChatIcon, FilesIcon, MoreIcon, NavBackIcon, PreviewIcon, SidebarIcon, TabsIcon, TilesIcon,
} from '#lib/icons'
import { goBackScreen } from '#lib/mobileHistory'
import { previewLabel } from '#lib/preview'
import { useUiStore } from '#lib/store'
import { useIsMobile } from '#lib/viewport'
import type { PortMapping } from '@yaac/shared/types'

/*
 * The bar over the main pane, shared by a workspace's header and the
 * new-workspace pane's, so both offer the same controls in the same place.
 */

/** The bar's labeled buttons: view mode, new shell, files, changes. */
export const BAR_BUTTON = 'flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] '
  + 'text-text-dim transition hover:bg-surface-2 hover:text-text disabled:opacity-50 '
  + 'disabled:hover:bg-transparent disabled:hover:text-text-dim'

/** The bar's classes. On mobile the warning badges (git auth, blocked
 *  hosts, unforwarded ports) stay in the bar and other controls move to an
 *  overflow menu. */
export function paneBarClass(isMobile: boolean): string {
  return isMobile
    ? 'flex h-12 shrink-0 items-center gap-1 border-b border-hairline pl-1 pr-1.5 text-xs'
    : 'flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs'
}

/**
 * The bar's leading button: back to the workspace list on mobile, or the
 * show-sidebar toggle on desktop while the sidebar is hidden.
 */
export function PaneBarLeading(): JSX.Element | null {
  const isMobile = useIsMobile()
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  if (isMobile) {
    return (
      <button
        onClick={goBackScreen}
        title="Back to workspaces"
        aria-label="Back to workspaces"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-dim
          transition active:bg-surface-2"
      >
        <NavBackIcon size={18} />
      </button>
    )
  }
  if (sidebarOpen) return null
  return (
    <button
      onClick={toggleSidebar}
      title="Show sidebar"
      aria-label="Show sidebar"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
        hover:bg-surface-2 hover:text-text-dim"
    >
      <SidebarIcon size={14} />
    </button>
  )
}

/** What the pane actions do; `disabled` says why they can't, and `titles`
 *  overrides their hover text. A running workspace can also open a session
 *  (`onNewSession`). */
interface PaneActions {
  onNewSession?: () => void
  onNewShell: () => void
  onOpenFiles: () => void
  onOpenChanges: () => void
  disabled?: string
  titles?: { shell: string; files: string; changes: string }
}

/** The desktop bar's view toggle and pane buttons. */
export function PaneBarActions({
  onNewSession, onNewShell, onOpenFiles, onOpenChanges, disabled, titles,
}: PaneActions): JSX.Element {
  const viewMode = useUiStore((s) => s.viewMode)
  const setViewMode = useUiStore((s) => s.setViewMode)
  const tiled = viewMode === 'tiles'
  const off = disabled !== undefined
  return (
    <>
      <button
        onClick={() => setViewMode(tiled ? 'tabs' : 'tiles')}
        title={tiled ? 'Switch to tabs' : 'Switch to tiles'}
        className={BAR_BUTTON}
      >
        {tiled ? <TabsIcon size={13} /> : <TilesIcon size={13} />}
        <span className="max-lg:sr-only">{tiled ? 'Tab view' : 'Tile view'}</span>
      </button>
      {onNewSession !== undefined && (
        <button onClick={onNewSession} disabled={off} title={disabled ?? 'Start another agent session here'} className={BAR_BUTTON}>
          <ChatIcon size={13} />
          <span className="max-lg:sr-only">New Session</span>
        </button>
      )}
      <button onClick={onNewShell} disabled={off} title={disabled ?? titles?.shell ?? 'New shell'} className={BAR_BUTTON}>
        <AddIcon size={13} />
        <span className="max-lg:sr-only">New Shell</span>
      </button>
      <button
        onClick={onOpenFiles}
        disabled={off}
        title={disabled ?? titles?.files ?? 'Browse files'}
        aria-label="Browse files"
        className={BAR_BUTTON}
      >
        <FilesIcon size={13} />
        Files
      </button>
      <button
        onClick={onOpenChanges}
        disabled={off}
        title={disabled ?? titles?.changes ?? 'Show changes'}
        aria-label="Show changes"
        className={BAR_BUTTON}
      >
        <ChangesIcon size={13} />
        Changes
      </button>
    </>
  )
}

/**
 * The mobile bar's ⋯ menu, holding the desktop bar's controls that don't
 * fit on a phone. Warning badges stay in the bar.
 */
export function PaneOverflowMenu({
  label,
  previewPorts = [],
  onOpenPreview,
  onNewSession,
  onNewShell,
  onOpenChanges,
  onOpenFiles,
  disabled,
}: PaneActions & {
  /** The menu's footnote: the workspace's agent. */
  label: string
  /** Forwarded ports to preview (empty in a browser). */
  previewPorts?: PortMapping[]
  onOpenPreview?: (containerPort: number) => void
}): JSX.Element {
  // Taller rows than other menus: this one is for touch.
  const ITEM = clsx(MENU_ITEM, 'py-2!')
  const off = disabled !== undefined
  return (
    <Menu.Root>
      <Menu.Trigger
        title="More"
        aria-label="More pane actions"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-dim
          transition active:bg-surface-2 data-[popup-open]:bg-surface-2"
      >
        <MoreIcon size={18} />
      </Menu.Trigger>
      <MenuPopup side="bottom" align="end" sideOffset={6} className="min-w-[200px]">
        {onNewSession !== undefined && (
          <Menu.Item className={ITEM} disabled={off} onClick={onNewSession}>
            <ChatIcon size={14} />
            New session
          </Menu.Item>
        )}
        <Menu.Item className={ITEM} disabled={off} onClick={onNewShell}>
          <AddIcon size={14} />
          New shell
        </Menu.Item>
        <Menu.Item className={ITEM} disabled={off} onClick={onOpenChanges}>
          <ChangesIcon size={14} />
          Review changes
        </Menu.Item>
        <Menu.Item className={ITEM} disabled={off} onClick={onOpenFiles}>
          <FilesIcon size={14} />
          Browse files
        </Menu.Item>
        {previewPorts.map((p) => (
          <Menu.Item key={p.containerPort} className={ITEM} onClick={() => onOpenPreview?.(p.containerPort)}>
            <PreviewIcon size={14} />
            {previewLabel(previewPorts.length > 1 ? p : undefined)}
          </Menu.Item>
        ))}
        <div className="px-2 pb-1 pt-1.5 text-[11px] text-text-faint">{disabled ?? label}</div>
      </MenuPopup>
    </Menu.Root>
  )
}
