import { useEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import clsx from 'clsx'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { Menu } from '@base-ui/react/menu'
import { layoutOf, useUiStore } from '#lib/store'
import { WorkspaceTerminal } from '#components/WorkspaceTerminal'
import { WorkspacePreview } from '#components/WorkspacePreview'
import { WorkspaceChat } from '#components/WorkspaceChat'
import { TuiTranscriptSearch } from '#components/TuiTranscriptSearch'
import { WorkspaceFiles } from '#components/WorkspaceFiles'
import { WorkspaceFile } from '#components/WorkspaceFile'
import { isPreviewTarget, previewLabel } from '#lib/preview'
import {
  discardFileSavers, fileKey, fileTabLabels, fileTargetPath, flushFileSavers, isChangesTarget, isFileTarget,
  isFilesTarget,
} from '#lib/files'
import { acpTargetSession, isAcpTarget } from '@yaac/shared/acp'
import { defaultPaneTarget, isSpecialPane, syncPaneLayout } from '#lib/panes'
import { agentLabel } from '#lib/agentLabel'
import { isElectron } from '#lib/platform'
import { goBackScreen } from '#lib/mobileHistory'
import { useIsMobile } from '#lib/viewport'
import { WorkspaceTitle } from '#components/WorkspaceTitle'
import { CreatingPlaceholder } from '#components/CreatingPlaceholder'
import { TerminalKeyBar } from '#components/TerminalKeyBar'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import {
  AddIcon, ChangesIcon, ChevronIcon, CloseIcon, FilesIcon, MoreIcon, NavBackIcon, PreviewIcon, SidebarIcon, TabsIcon,
  TerminalIcon, TilesIcon, TOOL_LABEL,
} from '#lib/icons'
import { EmptyState } from '#components/ui/EmptyState'
import { NewWorkspaceButton } from '#components/NewWorkspaceButton'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { UnforwardedPortsBadge } from '#components/UnforwardedPortsBadge'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { GitStatusBar } from '#components/GitStatusBar'
import { ForwardedPortLinks, portLinkHref, portLinkLabel } from '#components/ForwardedPortLinks'
import { api } from '#lib/api'
import { usePressDrag } from '#lib/usePressDrag'
import { useKeptPanes } from '#lib/useKeptPanes'
import { usePaneShortcuts } from '#lib/usePaneShortcuts'
import {
  computeColumns,
  dropTargetAt,
  focusPaneTarget,
  moveTargetToColumn,
  moveTargetToGroup,
  paneTargets,
  removeTarget,
  type ColumnRect,
  type DropTarget,
  type PaneLayout,
} from '#lib/layout'
import type {
  ProvisioningWorkspaceEntry,
  ServerSnapshot,
  WorkspaceTerminalEntry,
  WorkspaceListEntry,
} from '@yaac/shared/types'

/** Gap between column cards. */
const GAP = 8
/** Pane card header (tab strip) height. */
const HEADER_H = 28
/** The same strip on mobile, tall enough for a finger. */
const MOBILE_HEADER_H = 38
/** Pane card inner padding around the terminal block. */
const PAD = 3
/** Most workspaces attached in the background after a page load. Each costs
 *  a server-side PTY, so a large install shouldn't open dozens at once;
 *  the rest attach when first viewed. */
const EAGER_ATTACH_MAX = 12
/** The same limit on a phone, where each live stream costs mobile data. */
const MOBILE_EAGER_ATTACH_MAX = 2

/**
 * A pane's tab label. An agent pane is named for its tool and model
 * ("Claude · Opus 5"): `agent` is the primary tui window (lowest ordinal),
 * and `acp:<id>` names its conversation. A file pane uses `fileLabels`
 * (see `fileTabLabels`), else its path. `workspace` is omitted only by
 * callers that name terminals.
 */
function paneName(
  target: string,
  terminals: WorkspaceTerminalEntry[] | undefined,
  previewPort?: number,
  workspace?: WorkspaceListEntry,
  fileLabels?: Record<string, string>,
): string {
  if (isPreviewTarget(target)) return previewLabel(previewPort)
  if (isFilesTarget(target)) return 'Files'
  if (isChangesTarget(target)) return 'Changes'
  if (isFileTarget(target)) return fileLabels?.[fileTargetPath(target)] ?? fileTargetPath(target)
  if (target === 'agent' || isAcpTarget(target)) {
    const sessions = workspace?.agentSessions ?? []
    const session = isAcpTarget(target)
      ? sessions.find((a) => a.agentSessionId === acpTargetSession(target))
      : [...sessions].sort((a, b) => a.ordinal - b.ordinal).find((a) => a.mode !== 'acp')
    return workspace === undefined ? 'Agent' : agentLabel(workspace.tool, session)
  }
  const entry = terminals?.find((t) => t.target === target)
  return entry?.name ?? 'window'
}

export function WorkspaceView({
  snapshot,
  provisioning,
}: {
  snapshot: ServerSnapshot | undefined
  provisioning: ProvisioningWorkspaceEntry[]
}): JSX.Element {
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId)
  const focusNonce = useUiStore((s) => s.focusNonce)
  const terminalNonces = useUiStore((s) => s.terminalNonces)
  const layouts = useUiStore((s) => s.layouts)
  const setWorkspaceLayout = useUiStore((s) => s.setWorkspaceLayout)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const viewMode = useUiStore((s) => s.viewMode)
  const setViewMode = useUiStore((s) => s.setViewMode)
  const activeTabs = useUiStore((s) => s.activeTabs)
  const focusTerminal = useUiStore((s) => s.focusTerminal)
  const previewPortMap = useUiStore((s) => s.previewPort)
  const setPreviewPort = useUiStore((s) => s.setPreviewPort)
  const openPreview = useUiStore((s) => s.openPreview)
  const openChanges = useUiStore((s) => s.openChanges)
  const openFiles = useUiStore((s) => s.openFiles)
  const dirtyFiles = useUiStore((s) => s.dirtyFiles)
  // On a phone this pane is its own screen, with a back button, an overflow
  // menu and no tiles mode (docs/mobile-layout.md).
  const isMobile = useIsMobile()
  // A number, not a class: pane rects are computed below the tab strip.
  const headerH = isMobile ? MOBILE_HEADER_H : HEADER_H
  const workspaces = snapshot?.workspaces ?? []
  const workspace = workspaces.find((s) => s.workspaceId === selectedWorkspaceId)
  const sid = workspace?.workspaceId ?? null
  // Project-wide, but shown here since it breaks git in this workspace too.
  const gitAuthFailures = (workspace && snapshot?.gitAuthFailures?.[workspace.projectId]) || []

  // Forwarded ports open in the embedded preview in the desktop app, and as
  // external-link chips in a browser.
  const embedPreview = isElectron()
  const previewPorts = workspace?.forwardedPorts ?? []
  const chipPorts = embedPreview ? [] : previewPorts
  const previewPortForWorkspace = sid ? previewPortMap[sid] : undefined
  // With several ports, the header's Preview button (and Alt-P) offers a
  // choice of port. The shortcut opens that menu from wherever focus is, and
  // a dismissed menu hands focus back there.
  const pickPreviewPort = embedPreview && !isMobile && previewPorts.length > 1
  const previewMenuTrigger = useRef<HTMLButtonElement>(null)
  const previewMenuReturn = useRef<HTMLElement | null>(null)

  // Show the provisioning placeholder only when its row is selected and the
  // workspace isn't listed yet.
  const creatingHere = workspace ? null : provisioning.find((p) => p.workspaceId === selectedWorkspaceId) ?? null

  const layout: PaneLayout = sid ? layoutOf(layouts, sid, defaultPaneTarget(workspace)) : []

  // The workspace's non-agent terminals, which decide which panes exist and
  // their names. The last listing names the tabs while the snapshot has none
  // (after a server restart, or while the workspace stops).
  const lastTerminals = useRef<Record<string, WorkspaceTerminalEntry[]>>({})
  if (sid && workspace?.terminals) lastTerminals.current[sid] = workspace.terminals
  const terminals = sid ? lastTerminals.current[sid] : undefined
  // A shell just created, focused once the window sync has opened its pane.
  const pendingFocus = useRef<{ sid: string; target: string } | null>(null)

  // Pane area size; columns are absolutely positioned from it.
  const wsRef = useRef<HTMLDivElement>(null)
  const [wsSize, setWsSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wsRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setWsSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the layout's panes in line with the workspace's windows and
  // conversations.
  useEffect(() => {
    if (!sid || !workspace?.terminals) return
    const next = syncPaneLayout(layout, workspace, workspace.terminals.map((t) => t.target))
    if (next !== layout) setWorkspaceLayout(sid, next)
    const pending = pendingFocus.current
    if (pending?.sid === sid && paneTargets(next).includes(pending.target)) {
      pendingFocus.current = null
      useUiStore.getState().focusTerminal(sid, pending.target)
    }
  }, [sid, workspace, layout, setWorkspaceLayout])

  // Tabs mode shows all panes as one tab strip; the column layout is kept so
  // switching back to tiles restores it.
  const targets = paneTargets(layout)
  const activeTab = sid
    ? (activeTabs[sid] && targets.includes(activeTabs[sid]) ? activeTabs[sid] : targets[0])
    : undefined
  // Tiles is turned off on mobile at render only, so a phone doesn't
  // overwrite the desktop preference in the store.
  const tiled = viewMode === 'tiles' && !isMobile
  // Only this pane gets a focusKey, so bumping focusNonce focuses it and no
  // hidden pane.
  const focusTarget = sid ? focusPaneTarget(targets, activeTabs[sid], tiled) : null
  // Equal-width columns, each showing its active tab; other tabs stay
  // mounted but hidden.
  const cols = computeColumns(layout, { x: 0, y: 0, w: wsSize.w, h: wsSize.h }, GAP)
  const colsRef = useRef<ColumnRect[]>(cols)
  colsRef.current = cols
  // Each column's visible pane rect, for positioning and the drop highlight.
  const activePaneRect = new Map(cols.map((c) => [c.group.active, c.rect]))

  // Eager attach: after a page load, each live workspace's default pane
  // (`defaultPaneTarget`) is kept mounted hidden. Only the default pane,
  // since it exists for every workspace and persisted window ids may be
  // stale. Limited by EAGER_ATTACH_MAX.
  const { mounted, forget, lastRects } = useKeptPanes({
    sid,
    layout,
    layouts,
    workspaces,
    eagerKeys: workspaces
      .filter((s) => !s.stopping)
      .slice(0, isMobile ? MOBILE_EAGER_ATTACH_MAX : EAGER_ATTACH_MAX)
      .map((s) => `${s.workspaceId}|${defaultPaneTarget(s)}`),
    // The tabs-mode rect, which is the size a pane is first shown at.
    eagerRect: wsSize.w > 0 && wsSize.h > 0
      ? { left: PAD, top: headerH, width: wsSize.w - PAD * 2, height: wsSize.h - headerH - PAD }
      : null,
  })

  /** Create a scratch-shell window and focus it. Its pane opens when the
   *  snapshot lists the window, which may be before or after this answer;
   *  focusing a target with no pane would leave focus on another one. */
  const openShell = (): void => {
    if (!sid) return
    void api.workspace[':id'].terminals.$post({ param: { id: sid } })
      .then((entry) => {
        const st = useUiStore.getState()
        if (paneTargets(layoutOf(st.layouts, sid)).includes(entry.target)) st.focusTerminal(sid, entry.target)
        else pendingFocus.current = { sid, target: entry.target }
      })
      .catch((e: unknown) => console.error('new shell failed', e))
  }

  // The pane's × or the kill shortcut asks before killing a tmux window.
  const [confirmKill, setConfirmKill] = useState<{ target: string; name: string } | null>(null)
  // A file pane whose unsaved text could not be saved on close.
  const [confirmDiscard, setConfirmDiscard] = useState<{ target: string; name: string } | null>(null)

  /** Kill a tmux window. Its pane closes when the snapshot drops it, so a
   *  failed kill leaves it open. */
  const killPane = (target: string): void => {
    if (!sid) return
    void api.workspace[':id'].terminals.close.$post({ param: { id: sid }, json: { target } })
      .catch((e: unknown) => console.error('kill terminal failed', e))
  }

  // Close a special pane without confirmation. A file pane saves first and
  // asks only if the save fails.
  const dropPane = (id: string, target: string): void => {
    if (isFileTarget(target)) discardFileSavers([fileKey(id, fileTargetPath(target))])
    const st = useUiStore.getState()
    st.setWorkspaceLayout(id, removeTarget(layoutOf(st.layouts, id), target))
    forget(`${id}|${target}`)
  }
  const closePane = (target: string): void => {
    if (!sid) return
    if (!isFileTarget(target)) {
      dropPane(sid, target)
      return
    }
    const id = sid
    void flushFileSavers([fileKey(id, fileTargetPath(target))]).then((landed) => {
      if (landed) dropPane(id, target)
      else setConfirmDiscard({ target, name: fileTargetPath(target) })
    })
  }
  usePaneShortcuts({
    sid,
    targets,
    activeTab,
    openPreview: previewPorts.length === 0 ? null : () => {
      if (!sid) return
      if (!pickPreviewPort) {
        openPreview(sid, previewPorts.length === 1 ? previewPorts[0].containerPort : undefined)
        return
      }
      // A click with no pointer opens the menu as a keypress would, with its
      // first item highlighted. Pressed again, it closes the menu, keeping
      // the return target recorded when it opened.
      const trigger = previewMenuTrigger.current
      const from = document.activeElement
      const wasOpen = trigger?.hasAttribute('data-popup-open')
      trigger?.click()
      if (!wasOpen) previewMenuReturn.current = from instanceof HTMLElement ? from : null
    },
    isMobile,
    openShell,
    closePane,
    askKill: (target) => setConfirmKill({ target, name: paneName(target, terminals) }),
  })

  // --- tab drag (rearrange columns / merge into tabs) ---
  // A tab's press selects it; a drag moves its pane (see dropTargetAt).
  const { drag, start: onTabDown } = usePressDrag<string, DropTarget>({
    over: (x) => {
      const ws = wsRef.current
      return ws ? dropTargetAt(colsRef.current, x - ws.getBoundingClientRect().left) : undefined
    },
    onDrop: ({ item: src, over }) => {
      if (!sid || !over) return
      const cur = useUiStore.getState()
      const node = layoutOf(cur.layouts, sid)
      cur.setWorkspaceLayout(sid, over.kind === 'tab'
        ? moveTargetToGroup(node, src, over.group)
        : moveTargetToColumn(node, src, over.index))
    },
  })

  // While dragging: a box over the target column, or a bar where a new
  // column would open.
  const dropHighlight: { rect: { x: number; y: number; w: number; h: number }; bar: boolean } | null =
    drag?.over
      ? (() => {
          const over = drag.over
          if (over.kind === 'tab') {
            const col = cols[over.group]
            return col ? { rect: col.rect, bar: false } : null
          }
          const i = over.index
          const barW = 3
          let cx: number
          if (cols.length === 0) cx = wsSize.w / 2
          else if (i <= 0) cx = cols[0].rect.x - GAP / 2
          else if (i >= cols.length) {
            const last = cols[cols.length - 1].rect
            cx = last.x + last.w + GAP / 2
          } else cx = cols[i].rect.x - GAP / 2
          return { rect: { x: cx - barW / 2, y: 0, w: barW, h: wsSize.h }, bar: true }
        })()
      : null

  const fileLabels = fileTabLabels(targets.filter(isFileTarget).map(fileTargetPath))
  const tabName = (t: string): string => paneName(t, terminals, previewPortForWorkspace, workspace, fileLabels)

  /** A tab in a column strip (tiles) or the single tab bar (tabs). */
  const renderTab = (
    t: string,
    opts: { isActive: boolean; onSelect: () => void; draggable: boolean },
  ): JSX.Element => {
    const dirty = sid !== null && isFileTarget(t) && dirtyFiles[fileKey(sid, fileTargetPath(t))] === true
    return (
      <span key={t} className="group/tab relative flex items-center">
        <button
          onPointerDown={opts.draggable ? (e) => onTabDown(e, t, opts.onSelect) : undefined}
          onClick={opts.draggable ? undefined : opts.onSelect}
          className={clsx(
            'rounded px-2 py-0.5 text-[11px] transition',
            // Finger-sized on mobile, where this strip is the only pane switcher.
            'max-md:h-8 max-md:rounded-md max-md:px-3 max-md:text-xs',
            opts.draggable && 'cursor-grab select-none active:cursor-grabbing',
            t !== 'agent' && 'pr-5 max-md:pr-7',
            drag?.item === t && 'opacity-60',
            opts.isActive
              ? 'bg-surface-3 font-medium text-text'
              : 'text-text-faint hover:text-text-dim',
          )}
        >
          {tabName(t)}
        </button>
        {isSpecialPane(t) ? (
          // A file with unsaved text shows a dot in place of the × until hovered.
          <button
            onClick={() => closePane(t)}
            title={dirty ? 'Unsaved changes — close' : 'Close pane'}
            aria-label={`Close ${tabName(t)}`}
            className={clsx('absolute right-0.5 flex h-4 w-4 items-center justify-center rounded',
              'text-text-faint transition hover:text-text group-hover/tab:opacity-100',
              'max-md:h-6 max-md:w-6 max-md:opacity-100', !dirty && 'opacity-0')}
          >
            {dirty && <span className="text-[9px] group-hover/tab:hidden">●</span>}
            <CloseIcon size={10} className={clsx(dirty && 'hidden group-hover/tab:block')} />
          </button>
        ) : t !== 'agent' && (
          <button
            onClick={() => setConfirmKill({ target: t, name: paneName(t, terminals) })}
            title={`Kill ${paneName(t, terminals)}`}
            aria-label={`Kill ${paneName(t, terminals)}`}
            className="absolute right-0.5 flex h-4 w-4 items-center justify-center rounded
              text-text-faint opacity-0 transition hover:text-text group-hover/tab:opacity-100
              max-md:h-6 max-md:w-6 max-md:opacity-100"
          >
            <CloseIcon size={10} />
          </button>
        )}
      </span>
    )
  }

  const leading: ReactNode = isMobile || !sidebarOpen ? <PaneBarLeading /> : null
  const headerClass = paneBarClass(isMobile)

  // The mobile key bar, only over a terminal pane.
  const keyBarTarget = isMobile && workspace && activeTab && !isSpecialPane(activeTab) ? activeTab : null

  return (
    <main className="flex h-full min-w-0 flex-col">
      {/* The workspace bar. */}
      {creatingHere ? (
        <header className={headerClass}>
          {leading}
          <span className="titlebar-drag min-w-0 flex-1 truncate font-medium text-text-dim">
            {creatingHere.kind === 'restart' ? 'Restarting workspace' : creatingHere.title ?? 'New workspace'}
          </span>
        </header>
      ) : workspace ? (
        <header className={headerClass}>
          {leading}
          <WorkspaceTitle
            workspaceId={workspace.workspaceId}
            title={workspace.title ?? ''}
            prompt={workspace.prompt ?? ''}
          />
          {!isMobile && (
            <button
              onClick={() => setViewMode(tiled ? 'tabs' : 'tiles')}
              title={tiled ? 'Switch to tabs' : 'Switch to tiles'}
              className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                text-text-dim transition hover:bg-surface-2 hover:text-text"
            >
              {tiled ? <TabsIcon size={13} /> : <TilesIcon size={13} />}
              <span className="max-lg:sr-only">{tiled ? 'Tab view' : 'Tile view'}</span>
            </button>
          )}
          {!isMobile && (
            <>
              <button
                onClick={openShell}
                title="New shell"
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                  text-text-dim transition hover:bg-surface-2 hover:text-text"
              >
                <AddIcon size={13} />
                <span className="max-lg:sr-only">New Shell</span>
              </button>
              <button
                onClick={() => openFiles(workspace.workspaceId)}
                title="Browse files"
                aria-label="Browse files"
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                  text-text-dim transition hover:bg-surface-2 hover:text-text"
              >
                <FilesIcon size={13} />
                Files
              </button>
              <button
                onClick={() => openChanges(workspace.workspaceId)}
                title="Show changes"
                aria-label="Show changes"
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                  text-text-dim transition hover:bg-surface-2 hover:text-text"
              >
                <ChangesIcon size={13} />
                Changes
              </button>
              {pickPreviewPort ? (
                <PreviewPortMenu
                  ports={previewPorts}
                  trigger={previewMenuTrigger}
                  returnFocus={previewMenuReturn}
                  onPick={(p) => openPreview(workspace.workspaceId, p)}
                />
              ) : embedPreview && previewPorts.length > 0 && (
                <button
                  onClick={() => openPreview(workspace.workspaceId, previewPorts[0].containerPort)}
                  title={`Open preview (${previewPorts.map(portLinkLabel).join(', ')})`}
                  aria-label="Open preview"
                  className={PREVIEW_BUTTON}
                >
                  <PreviewIcon size={11} />
                  Preview
                </button>
              )}
              {chipPorts.length > 0 && (
                <ForwardedPortLinks ports={chipPorts} iconSize={11} className="hover:bg-surface-2" />
              )}
            </>
          )}
          {workspace.unforwardedPorts.length > 0 && (
            <UnforwardedPortsBadge
              ports={workspace.unforwardedPorts}
              workspaceId={workspace.workspaceId}
              exposeHost={snapshot?.forwardBindHost ?? '127.0.0.1'}
              iconSize={11}
              className="hover:bg-surface-3"
            />
          )}
          {gitAuthFailures.length > 0 && (
            <GitAuthFailureBadge
              projectId={workspace.projectId}
              failures={gitAuthFailures}
              iconSize={12}
              className="hover:bg-danger/25"
            />
          )}
          {workspace.blockedHosts.length > 0 && (
            <BlockedHostsBadge hosts={workspace.blockedHosts} workspaceId={workspace.workspaceId} iconSize={12} className="hover:bg-danger/25" />
          )}
          {isMobile && (
            <PaneOverflowMenu
              tool={workspace.tool}
              chipPorts={chipPorts}
              previewPorts={embedPreview ? previewPorts : []}
              onNewShell={openShell}
              onOpenChanges={() => openChanges(workspace.workspaceId)}
              onOpenFiles={() => openFiles(workspace.workspaceId)}
              onOpenPreview={(p) => openPreview(workspace.workspaceId, p)}
            />
          )}
        </header>
      ) : (
        <header className={clsx(headerClass, 'titlebar-drag')}>
          {leading && <div className="no-drag">{leading}</div>}
        </header>
      )}

      {workspace && <GitStatusBar key={workspace.workspaceId} workspaceId={workspace.workspaceId} />}

      {/* `isolate` keeps the z-30 provisioning overlay below from painting
          over portaled dropdowns such as "+ New workspace". */}
      <div ref={wsRef} className="relative isolate min-h-0 flex-1">
        {!workspace && !creatingHere && (
          <EmptyState
            className="h-full"
            icon={TerminalIcon}
            title="No workspaces yet"
            description="Start a coding-agent workspace and it opens right here."
            action={activeProjectId
              ? <NewWorkspaceButton projectId={activeProjectId} variant="cta" />
              : undefined}
          />
        )}

        {/* Tiles mode: one card per column, with its tab strip. The panes
            below are positioned into the card bodies. */}
        {workspace && tiled && cols.map(({ group, rect }, gi) => (
          <section
            key={gi}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            className="absolute flex flex-col overflow-hidden rounded-lg border border-hairline
              bg-surface shadow-[0_8px_24px_var(--shadow-color)]"
          >
            <div style={{ height: headerH }} className="flex shrink-0 items-center gap-0.5 px-1.5">
              {group.tabs.map((t) => renderTab(t, {
                isActive: group.active === t,
                onSelect: () => focusTerminal(workspace.workspaceId, t),
                draggable: true,
              }))}
            </div>
          </section>
        ))}

        {/* Tabs mode: one card whose strip lists every pane. */}
        {workspace && !tiled && targets.length > 0 && (
          // Full-bleed on mobile, without rounding, border or shadow.
          <section className="absolute inset-0 flex flex-col overflow-hidden rounded-lg border
            border-hairline bg-surface shadow-[0_8px_24px_var(--shadow-color)]
            max-md:rounded-none max-md:border-0 max-md:shadow-none">
            <div
              style={{ height: headerH }}
              className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-1.5"
            >
              {targets.map((t) => renderTab(t, {
                isActive: activeTab === t,
                onSelect: () => focusTerminal(workspace.workspaceId, t),
                draggable: false,
              }))}
            </div>
          </section>
        )}

        {/* Mounted panes, positioned into their pane bodies. */}
        {mounted.map((key) => {
          const sep = key.indexOf('|')
          const id = key.slice(0, sep)
          const target = key.slice(sep + 1)
          const preview = isPreviewTarget(target)
          const explorer = isFilesTarget(target) || isChangesTarget(target)
          const file = isFileTarget(target)
          const chat = acpTargetSession(target)
          // Panes unmounted when off-screen, since they poll the workspace.
          // Chat panes stay mounted (re-attaching replays the conversation),
          // and so do file panes (unmounting loses undo history, cursor and
          // unsaved text).
          const ephemeral = preview || explorer
          // In tiles mode, a column's active tab is on-screen in its body.
          const colRect = id === sid && tiled ? activePaneRect.get(target) : undefined
          // Hidden panes never change size, since a resize round-trips to
          // tmux and would flash a stale frame when shown. In tabs mode all
          // of the selected workspace's tabs share one rect; other hidden
          // panes keep the last rect they were shown at.
          const tabsRect = {
            left: PAD,
            top: headerH,
            width: wsSize.w - PAD * 2,
            height: wsSize.h - headerH - PAD,
          }
          const onScreen = colRect != null || (id === sid && !tiled && target === activeTab)
          const focused = id === sid && target === activeTab
          const style = colRect
            ? {
                left: colRect.x + PAD,
                top: colRect.y + headerH,
                width: colRect.w - PAD * 2,
                height: colRect.h - headerH - PAD,
              }
            : id === sid && !tiled && (ephemeral ? target === activeTab : targets.includes(target))
              ? tabsRect
              : ephemeral
                ? undefined
                : lastRects.current.get(key)
          if (!ephemeral && style) lastRects.current.set(key, style)
          // Ephemeral panes only have a `style` for the selected workspace,
          // so previewPorts and previewPortForWorkspace apply to them.
          if (ephemeral && !style) return null
          return (
            <div
              key={key}
              style={style}
              // Track focus from clicks too, so the cycle shortcut starts
              // from the pane the user is in.
              onFocusCapture={() => useUiStore.getState().setActiveTab(id, target)}
              className={clsx('absolute', !onScreen && 'invisible', !style && 'left-0 top-0 h-full w-full')}
            >
              {preview ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorkspacePreview
                    workspaceId={id}
                    ports={previewPorts}
                    currentPort={previewPortForWorkspace}
                    onSwitchPort={(p) => setPreviewPort(id, p)}
                  />
                </div>
              ) : chat !== undefined ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorkspaceChat workspaceId={id} agentSessionId={chat} visible={onScreen} focused={focused} />
                </div>
              ) : file ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorkspaceFile
                    workspaceId={id}
                    path={fileTargetPath(target)}
                    visible={onScreen}
                    onClose={() => dropPane(id, target)}
                  />
                </div>
              ) : explorer ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  {(() => {
                    const ws = workspaces.find((s) => s.workspaceId === id)
                    return (
                      <WorkspaceFiles
                        workspaceId={id}
                        projectId={ws?.projectId ?? ''}
                        baseBranch={ws?.baseBranch}
                        changedOnly={isChangesTarget(target)}
                      />
                    )
                  })()}
                </div>
              ) : (
                <div className="relative h-full w-full overflow-hidden rounded-md bg-bg px-2.5 py-1.5">
                  <WorkspaceTerminal
                    key={`${key}:${terminalNonces[id] ?? 0}`}
                    workspaceId={id}
                    target={target}
                    visible={onScreen}
                    focusKey={id === sid && target === focusTarget ? focusNonce : undefined}
                  />
                  {target === 'agent' && (
                    <TuiTranscriptSearch
                      workspaceId={id}
                      sessions={workspaces.find((s) => s.workspaceId === id)?.agentSessions ?? []}
                      visible={onScreen}
                      focused={focused}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* Drop highlight while dragging a pane. */}
        {dropHighlight && (
          <div
            style={{
              left: dropHighlight.rect.x,
              top: dropHighlight.rect.y,
              width: dropHighlight.rect.w,
              height: dropHighlight.rect.h,
            }}
            className={clsx(
              'pointer-events-none absolute z-20',
              dropHighlight.bar
                ? 'rounded-full bg-accent'
                : 'rounded-lg border border-accent/60 bg-accent/15',
            )}
          />
        )}

        {/* Provisioning overlay, covering the pane area until ready. */}
        {creatingHere && (
          <div className="absolute inset-0 z-30 bg-shell">
            <CreatingPlaceholder creating={creatingHere} />
          </div>
        )}
      </div>

      {/* Outside the measured pane area rather than over it, so the
          terminal shrinks to make room. */}
      {keyBarTarget && sid && <TerminalKeyBar workspaceId={sid} target={keyBarTarget} />}

      <ConfirmDialog
        open={!!confirmDiscard}
        onOpenChange={(next) => { if (!next) setConfirmDiscard(null) }}
        title={`Discard unsaved changes to “${confirmDiscard?.name ?? ''}”?`}
        description="They could not be saved: the file changed or was deleted on disk, or saving is failing."
        confirmLabel="Discard"
        onConfirm={() => {
          if (confirmDiscard && sid) dropPane(sid, confirmDiscard.target)
          setConfirmDiscard(null)
        }}
      />
      <ConfirmDialog
        open={!!confirmKill}
        onOpenChange={(next) => { if (!next) setConfirmKill(null) }}
        title={`Kill terminal “${confirmKill?.name ?? ''}”?`}
        description="This kills the tmux window and whatever is running in it."
        confirmLabel="Kill"
        onConfirm={() => {
          if (confirmKill) killPane(confirmKill.target)
          setConfirmKill(null)
        }}
      />
    </main>
  )
}

/**
 * The workspace bar's leading button: back to the workspace list on mobile,
 * or the show-sidebar toggle on desktop while the sidebar is hidden.
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

/** The workspace bar's classes. On mobile the warning badges (git auth,
 *  blocked hosts, unforwarded ports) stay in the bar and other controls move
 *  to an overflow menu. */
export function paneBarClass(isMobile: boolean): string {
  return isMobile
    ? 'flex h-12 shrink-0 items-center gap-1 border-b border-hairline pl-1 pr-1.5 text-xs'
    : 'flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs'
}

const PREVIEW_BUTTON = 'flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] '
  + 'text-text-dim transition hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2'

/**
 * The header's Preview button for a workspace with several forwarded ports:
 * a menu of them, whose pick opens the preview on that port. A pick leaves
 * focus with the pane it opened; a dismissal returns it to `returnFocus`
 * when set (the menu was opened by shortcut), else to the button.
 */
function PreviewPortMenu({
  ports,
  trigger,
  returnFocus,
  onPick,
}: {
  ports: WorkspaceListEntry['forwardedPorts']
  trigger: RefObject<HTMLButtonElement | null>
  returnFocus: RefObject<HTMLElement | null>
  onPick: (containerPort: number) => void
}): JSX.Element {
  const picked = useRef(false)
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (!open) return
        picked.current = false
        returnFocus.current = null
      }}
    >
      <Menu.Trigger
        ref={trigger}
        title={`Open preview (${ports.map(portLinkLabel).join(', ')})`}
        aria-label="Open preview"
        className={PREVIEW_BUTTON}
      >
        <PreviewIcon size={11} />
        Preview
        <ChevronIcon size={10} className="rotate-90" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4}>
          <Menu.Popup
            finalFocus={() => !picked.current && (returnFocus.current?.isConnected ? returnFocus.current : true)}
            className={clsx('min-w-[120px]', POPUP)}
          >
            {ports.map((p) => (
              <Menu.Item
                key={p.containerPort}
                className={MENU_ITEM}
                onClick={() => { picked.current = true; onPick(p.containerPort) }}
              >
                <span className="font-mono">:{p.containerPort}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/**
 * The mobile workspace bar's ⋯ menu, holding the desktop bar's controls
 * that don't fit on a phone. Warning badges stay in the bar.
 */
function PaneOverflowMenu({
  tool,
  chipPorts,
  previewPorts,
  onNewShell,
  onOpenChanges,
  onOpenFiles,
  onOpenPreview,
}: {
  tool: WorkspaceListEntry['tool']
  /** Forwarded ports shown as external links (browser only). */
  chipPorts: WorkspaceListEntry['forwardedPorts']
  /** Forwarded ports for the embedded preview pane (Electron only). */
  previewPorts: WorkspaceListEntry['forwardedPorts']
  onNewShell: () => void
  onOpenChanges: () => void
  onOpenFiles: () => void
  onOpenPreview: (containerPort: number) => void
}): JSX.Element {
  const ITEM = 'flex w-full cursor-default items-center gap-2 rounded-md px-2 py-2 text-xs '
    + 'text-text-dim outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-text'
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
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6}>
          <Menu.Popup className={clsx('min-w-[200px]', POPUP)}>
            <Menu.Item className={ITEM} onClick={onNewShell}>
              <AddIcon size={14} />
              New shell
            </Menu.Item>
            <Menu.Item className={ITEM} onClick={onOpenChanges}>
              <ChangesIcon size={14} />
              Review changes
            </Menu.Item>
            <Menu.Item className={ITEM} onClick={onOpenFiles}>
              <FilesIcon size={14} />
              Browse files
            </Menu.Item>
            {previewPorts.map((p) => (
              <Menu.Item key={p.containerPort} className={ITEM} onClick={() => onOpenPreview(p.containerPort)}>
                <PreviewIcon size={14} />
                {previewLabel(previewPorts.length > 1 ? p.containerPort : undefined)}
              </Menu.Item>
            ))}
            {/* window.open from a click, which popup blockers allow. */}
            {chipPorts.map((p) => (
              <Menu.Item
                key={`${p.hostPort}:${p.containerPort}`}
                className={ITEM}
                onClick={() => window.open(portLinkHref(window.location.hostname, p), '_blank', 'noopener')}
              >
                <PreviewIcon size={14} />
                <span className="font-mono">{portLinkLabel(p)}</span>
              </Menu.Item>
            ))}
            <div className="px-2 pb-1 pt-1.5 text-[11px] text-text-faint">{TOOL_LABEL[tool]}</div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

