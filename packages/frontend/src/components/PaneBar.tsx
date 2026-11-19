import type { JSX } from 'react'
import {
  AddIcon, ChangesIcon, ChatIcon, CommitsIcon, FilesIcon, HistoryIcon, MoreIcon, NavBackIcon, PreviewIcon, SidebarIcon,
  TabsIcon, TilesIcon, type Icon,
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

/** The bar's classes. On mobile most controls move to an overflow menu;
 *  the warnings are in the Details pane at every width. */
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

/** What the pane actions do; `disabled` says why they can't, and `titles`
 *  overrides their hover text. A running workspace can also open a session
 *  (`onNewSession`), and one with earlier conversations its History pane
 *  (`onOpenHistory`). */
interface PaneActions {
  onNewSession?: () => void
  onNewShell?: () => void
  onOpenFiles: () => void
  onOpenChanges: () => void
  onOpenCommits: () => void
  onOpenHistory?: () => void
  disabled?: string
  titles?: { shell: string; files: string; changes: string; commits: string }
}

/** A new shell's tooltip: what it prints is kept (docs/workspace-steps.md
 *  "Logs"), which a user typing a credential should know. */
export const NEW_SHELL_TITLE = 'New shell. What it prints is kept in the workspace\'s logs until the workspace is deleted.'

/** The desktop bar's view toggle and pane buttons. */
export function PaneBarActions({
  onNewSession, onNewShell, onOpenFiles, onOpenChanges, onOpenCommits, onOpenHistory, disabled, titles,
}: PaneActions): JSX.Element {
  const viewMode = useUiStore((s) => s.viewMode)
  const setViewMode = useUiStore((s) => s.setViewMode)
  const tiled = viewMode === 'tiles'
  const off = disabled !== undefined
  const action = (label: string, icon: Icon, onClick: () => void, title: string, enabled = true): JSX.Element => (
    <YButton variant="ghost" icon={icon} onClick={onClick} disabled={enabled && off} title={title} aria-label={label} />
  )
  return (
    <>
      {action(tiled ? 'Tab view' : 'Tile view', tiled ? TabsIcon : TilesIcon, () => setViewMode(tiled ? 'tabs' : 'tiles'),
        tiled ? 'Switch to tabs' : 'Switch to tiles', false)}
      {onNewSession !== undefined && action('New Session', ChatIcon, onNewSession, disabled ?? 'Start another agent session here')}
      {onNewShell !== undefined && action('New Shell', AddIcon, onNewShell, disabled ?? titles?.shell ?? NEW_SHELL_TITLE)}
      {action('Browse files', FilesIcon, onOpenFiles, disabled ?? titles?.files ?? 'Browse files')}
      {action('Show changes', ChangesIcon, onOpenChanges, disabled ?? titles?.changes ?? 'Show changes')}
      {action('Show commits', CommitsIcon, onOpenCommits, disabled ?? titles?.commits ?? 'Show commits')}
      {onOpenHistory !== undefined
        && action('History', HistoryIcon, onOpenHistory, "Read or resume closed sessions' conversations", false)}
    </>
  )
}

/**
 * The mobile bar's ⋯ menu, holding the desktop bar's controls that don't
 * fit on a phone.
 */
export function PaneOverflowMenu({
  label,
  previewPorts = [],
  onOpenPreview,
  onNewSession,
  onNewShell,
  onOpenChanges,
  onOpenCommits,
  onOpenFiles,
  onOpenHistory,
  disabled,
}: PaneActions & {
  /** The menu's footnote: the workspace's agent. */
  label: string
  /** Forwarded ports to preview (empty in a browser). */
  previewPorts?: PortMapping[]
  onOpenPreview?: (containerPort: number) => void
}): JSX.Element {
  // Taller rows than other menus: this one is for touch.
  const ITEM = 'py-2!'
  const off = disabled !== undefined
  return (
    <YMenu.Root>
      <YMenu.Trigger
        render={<YButton variant="ghost" icon={MoreIcon} title="More" aria-label="More pane actions" className="h-9! w-9!" />}
      />
      <YMenuPopup side="bottom" align="end" sideOffset={6} className="min-w-[200px]">
        {onNewSession !== undefined && (
          <YMenuItem icon={ChatIcon} className={ITEM} disabled={off} onClick={onNewSession}>
            New session
          </YMenuItem>
        )}
        {onNewShell !== undefined && (
          <YMenuItem icon={AddIcon} className={ITEM} disabled={off} onClick={onNewShell}>
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
        {onOpenHistory !== undefined && (
          <YMenuItem icon={HistoryIcon} className={ITEM} onClick={onOpenHistory}>
            Conversation history
          </YMenuItem>
        )}
        {previewPorts.map((p) => (
          <YMenuItem key={p.containerPort} icon={PreviewIcon} className={ITEM} onClick={() => onOpenPreview?.(p.containerPort)}>
            {previewLabel(previewPorts.length > 1 ? p : undefined)}
          </YMenuItem>
        ))}
        <YMenuLabel>{disabled ?? label}</YMenuLabel>
      </YMenuPopup>
    </YMenu.Root>
  )
}
