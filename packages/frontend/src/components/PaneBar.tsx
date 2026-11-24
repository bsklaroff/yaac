import { useRef, type JSX, type ReactNode, type Ref } from 'react'
import {
  AddIcon, ChangesIcon, ChatIcon, CommitsIcon, FilesIcon, HistoryIcon, MoreIcon, NavBackIcon, PreviewIcon, SidebarIcon,
  TabsIcon, TilesIcon,
} from '#lib/icons'
import { goBackScreen } from '#lib/mobileHistory'
import { hidesTitleBar } from '#lib/platform'
import { previewLabel } from '#lib/preview'
import { useUiStore } from '#lib/store'
import { useIsMobile } from '#lib/viewport'
import type { PortMapping } from '@yaac/shared/types'
import { YButton, YMenu, YMenuItem, YMenuLabel, YMenuPopup, YTrafficLights } from '#ui'

/*
 * The bar over the main pane, shared by a workspace's header and the
 * new-workspace pane's, so both offer the same controls in the same place.
 */

/** The bar's classes. */
export function paneBarClass(isMobile: boolean): string {
  return isMobile
    ? 'flex h-12 shrink-0 items-center gap-1 border-b border-line pl-1 pr-1.5 text-md'
    : 'flex h-bar shrink-0 items-center gap-1.5 border-b border-line px-3 text-md'
}

/** The button that shows the hidden sidebar. */
export function ShowSidebarButton(): JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  return <YButton variant="ghost" size="sm" icon={SidebarIcon} onClick={toggleSidebar} title="Show sidebar" aria-label="Show sidebar" />
}

/**
 * The bar's leading button: back to the workspace list on mobile. While
 * the sidebar is hidden, the show-sidebar button sits at the window's left
 * edge, in the bar's stretch over the rail (App); in the macOS desktop app
 * the traffic lights are there, so it comes here, after them.
 */
export function PaneBarLeading(): JSX.Element | null {
  const isMobile = useIsMobile()
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  if (isMobile) {
    return (
      <YButton
        variant="ghost"
        icon={NavBackIcon}
        onClick={goBackScreen}
        title="Back to workspaces"
        aria-label="Back to workspaces"
        className="h-9! w-9!"
      />
    )
  }
  if (sidebarOpen || !hidesTitleBar()) return null
  // The traffic lights overhang the rail into this bar, which starts 45px in.
  return (
    <>
      <YTrafficLights className="w-6" />
      <ShowSidebarButton />
    </>
  )
}

/** What the pane menu's actions do; `disabled` says why they can't. A
 *  running workspace can also open a session (`onNewSession`), and one with
 *  earlier conversations its History pane (`history`, with how many it
 *  holds). */
interface PaneActions {
  onNewSession?: () => void
  onNewShell?: () => void
  onOpenFiles: () => void
  onOpenChanges: () => void
  onOpenCommits: () => void
  history?: { count: number; onOpen: () => void }
  disabled?: string
}

/** What opens the History pane, counting the conversations it holds. */
export function stoppedConversationsLabel(count: number): string {
  return `${String(count)} stopped ${count === 1 ? 'conversation' : 'conversations'}`
}

/** A new shell's tooltip: what it prints is kept (docs/workspace-steps.md
 *  "Logs"), which a user typing a credential should know. */
export const NEW_SHELL_TITLE = 'New shell. What it prints is kept in the workspace\'s logs until the workspace is deleted.'

/**
 * The bar's ⋯ menu: the pane actions, kept out of the bar so the title and
 * git status have its room, then `children` (a workspace's Set a timeout).
 * On a desktop it also switches between tiles and tabs; a phone always
 * shows tabs, and lists the previews here. Its footnote says why the
 * actions are off, when they are.
 */
export function PaneMenu({
  previewPorts = [],
  onOpenPreview,
  onNewSession,
  onNewShell,
  onOpenChanges,
  onOpenCommits,
  onOpenFiles,
  history,
  disabled,
  children,
  triggerRef,
}: PaneActions & {
  /** Forwarded ports to preview (empty in a browser). */
  previewPorts?: PortMapping[]
  onOpenPreview?: (containerPort: number) => void
  children?: ReactNode
  /** The ⋯ button, for a control that hands focus back to it. */
  triggerRef?: Ref<HTMLButtonElement>
}): JSX.Element {
  const isMobile = useIsMobile()
  const viewMode = useUiStore((s) => s.viewMode)
  const setViewMode = useUiStore((s) => s.setViewMode)
  const tiled = viewMode === 'tiles'
  // Taller rows on a phone, for touch.
  const ITEM = isMobile ? 'py-2!' : undefined
  const off = disabled !== undefined
  // Whether an item ran: then focus stays where it put it (the pane it
  // opened, the timeout box), and only a dismissal returns it to ⋯. Not
  // modal, since a modal menu holds focus while it closes, which would blur
  // a box an item opens.
  const picked = useRef(false)
  return (
    <YMenu.Root modal={false} onOpenChange={(open) => { if (open) picked.current = false }}>
      <YMenu.Trigger
        ref={triggerRef}
        render={<YButton variant="ghost" icon={MoreIcon} title="More" aria-label="More pane actions" className={isMobile ? 'h-9! w-9!' : undefined} />}
      />
      <YMenuPopup
        side="bottom"
        align="end"
        sideOffset={6}
        className="min-w-[200px]"
        // Submenu items bubble here too, through React's portal tree.
        onClickCapture={(e) => {
          const item = (e.target as HTMLElement).closest('[role="menuitem"]')
          if (item !== null && !item.hasAttribute('aria-haspopup')) picked.current = true
        }}
        finalFocus={() => !picked.current}
      >
        {history !== undefined && (
          <YMenuItem icon={HistoryIcon} className={ITEM} onClick={history.onOpen}>
            {stoppedConversationsLabel(history.count)}
          </YMenuItem>
        )}
        {onNewSession !== undefined && (
          <YMenuItem icon={ChatIcon} className={ITEM} disabled={off} onClick={onNewSession}>
            New agent
          </YMenuItem>
        )}
        {onNewShell !== undefined && (
          <YMenuItem icon={AddIcon} className={ITEM} disabled={off} onClick={onNewShell} title={NEW_SHELL_TITLE}>
            New shell
          </YMenuItem>
        )}
        <YMenuItem icon={ChangesIcon} className={ITEM} disabled={off} onClick={onOpenChanges}>
          Review changes
        </YMenuItem>
        <YMenuItem icon={CommitsIcon} className={ITEM} disabled={off} onClick={onOpenCommits}>
          Commits
        </YMenuItem>
        <YMenuItem icon={FilesIcon} className={ITEM} disabled={off} onClick={onOpenFiles}>
          Browse files
        </YMenuItem>
        {previewPorts.map((p) => (
          <YMenuItem key={p.containerPort} icon={PreviewIcon} className={ITEM} onClick={() => onOpenPreview?.(p.containerPort)}>
            {previewLabel(previewPorts.length > 1 ? p : undefined)}
          </YMenuItem>
        ))}
        {children}
        {!isMobile && (
          <YMenuItem icon={tiled ? TabsIcon : TilesIcon} onClick={() => setViewMode(tiled ? 'tabs' : 'tiles')}>
            {tiled ? 'Switch to tabs' : 'Switch to tiles'}
          </YMenuItem>
        )}
        {disabled !== undefined && <YMenuLabel>{disabled}</YMenuLabel>}
      </YMenuPopup>
    </YMenu.Root>
  )
}
