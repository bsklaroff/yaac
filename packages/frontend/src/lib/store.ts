import { create } from 'zustand'
import { addColumn, isPaneLayout, removeTarget, renameTargets, singleColumn, withActive, type PaneLayout } from '#lib/layout'
import { PREVIEW_TARGET } from '#lib/preview'
import { CHANGES_TARGET } from '#lib/changesApi'
import { FILES_TARGET, fileKey, fileTarget, placeFile } from '#lib/files'
import { DEFAULT_BINDINGS, type BindingMap, type Chord, type ShortcutId } from '#lib/shortcuts'
import { applyThemeAttribute, loadThemePref, persistThemePref, type ThemePref } from '#lib/theme'
import type { AgentTool, StoppedWorkspaceEntry, ProvisioningWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'

const LAYOUTS_LS_KEY = 'yaac.layouts.v2'
const VIEWMODE_LS_KEY = 'yaac.viewmode.v1'
const SELECTION_LS_KEY = 'yaac.selection.v1'
const READ_WAITING_LS_KEY = 'yaac.readwaiting.v1'
const PINNED_USAGE_LS_KEY = 'yaac.pinnedusage.v1'
const SOUND_LS_KEY = 'yaac.sound.v1'
const CHAT_DRAFTS_LS_KEY = 'yaac.chatdrafts.v1'
const MOBILE_SCREEN_LS_KEY = 'yaac.mobilescreen.v1'
const SIDEBAR_WIDTH_LS_KEY = 'yaac.sidebarwidth.v1'
const EDITOR_FONT_LS_KEY = 'yaac.editorfontsize.v1'
const CHAT_FULL_WIDTH_LS_KEY = 'yaac.chatfullwidth.v1'

/** Desktop sidebar width in px: the default and the drag bounds. */
export const DEFAULT_SIDEBAR_WIDTH = 256
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 640

/** Clamp a sidebar width to the bounds. */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SIDEBAR_WIDTH
  return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, px)))
}

/** Saved sidebar width, or the default when unset or invalid. */
export function loadSidebarWidth(): number {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_LS_KEY)
      if (raw !== null && raw.trim() !== '') {
        const px = Number(raw)
        if (Number.isFinite(px)) return clampSidebarWidth(px)
      }
    }
  } catch { /* fall through to the default */ }
  return DEFAULT_SIDEBAR_WIDTH
}

/** Save the sidebar width (best-effort). */
export function persistSidebarWidth(px: number): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SIDEBAR_WIDTH_LS_KEY, String(px))
  } catch { /* non-fatal — the width just won't stick */ }
}

/** Whether the attention chime plays; on by default. */
export function loadSoundEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(SOUND_LS_KEY) !== '0'
  } catch { /* fall through to the default */ }
  return true
}

/** Save the sound preference (best-effort). */
export function persistSoundEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_LS_KEY, enabled ? '1' : '0')
  } catch { /* non-fatal */ }
}

/** Whether chat panes span the full pane width; off by default. */
export function loadChatFullWidth(): boolean {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(CHAT_FULL_WIDTH_LS_KEY) === '1'
  } catch { /* fall through to the default */ }
  return false
}

/** Save the chat width preference (best-effort). */
export function persistChatFullWidth(full: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CHAT_FULL_WIDTH_LS_KEY, full ? '1' : '0')
  } catch { /* non-fatal */ }
}

/** File-pane editor font size, in px, and the range the A−/A+ steps stay in. */
export const DEFAULT_EDITOR_FONT_SIZE = 12
export const MIN_EDITOR_FONT_SIZE = 9
export const MAX_EDITOR_FONT_SIZE = 24

const clampEditorFontSize = (px: number): number =>
  Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Math.round(px)))

/** Saved editor font size, clamped, or the default when unset or invalid. */
export function loadEditorFontSize(): number {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(EDITOR_FONT_LS_KEY) : null
    if (raw && raw.trim() !== '' && Number.isFinite(Number(raw))) return clampEditorFontSize(Number(raw))
  } catch { /* fall through to the default */ }
  return DEFAULT_EDITOR_FONT_SIZE
}

/**
 * Which of the three mobile screens is showing (docs/mobile-layout.md).
 * Unused above the mobile breakpoint.
 *
 * Stored rather than derived from the selection, because App auto-selects a
 * workspace after a project switch, and a derived screen would then skip
 * the workspace list. So user actions (`setActiveProject`,
 * `selectWorkspace`, `openWorkspace`) change the screen, and the app's own
 * (`restoreActiveProject`, `autoSelectWorkspace`) don't.
 */
export type MobileScreen = 'projects' | 'workspaces' | 'pane'

/**
 * The saved mobile screen, so a reload returns to it.
 *
 * With nothing saved, this is a first visit, so a `?workspace=` link opens
 * the pane. The URL alone can't decide, since persistSelection always
 * writes the params.
 */
export function loadMobileScreen(): MobileScreen {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(MOBILE_SCREEN_LS_KEY)
      if (raw === 'projects' || raw === 'workspaces' || raw === 'pane') return raw
    }
  } catch { /* fall through — treat as never visited */ }
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.get('workspace')) return 'pane'
      if (params.get('project')) return 'workspaces'
    }
  } catch { /* fall through to the default */ }
  return 'projects'
}

/** Save the mobile screen (best-effort). */
export function persistMobileScreen(screen: MobileScreen): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MOBILE_SCREEN_LS_KEY, screen)
  } catch { /* non-fatal */ }
}

/** How a workspace's panes are shown: side-by-side columns, or one tab at a
 *  time. */
export type ViewMode = 'tiles' | 'tabs'

/** Saved view mode; on first run, based on the viewport width. */
export function loadViewMode(viewportWidth?: number): ViewMode {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(VIEWMODE_LS_KEY)
      if (raw === 'tiles' || raw === 'tabs') return raw
    }
  } catch { /* fall through to the default */ }
  const width = viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1440)
  return width < 1024 ? 'tabs' : 'tiles'
}

function persistViewMode(mode: ViewMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEWMODE_LS_KEY, mode)
  } catch { /* non-fatal */ }
}

/** The selected project and workspace, saved so a reload or a shared link
 *  reopens the same view. */
export interface PersistedSelection {
  projectSlug: string | null
  workspaceId: string | null
}

/**
 * The saved selection. The URL query wins over localStorage, so a shared
 * link overrides the last local view. App drops the workspace if it is no
 * longer active.
 */
export function loadSelection(): PersistedSelection {
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const projectSlug = params.get('project')
      if (projectSlug) return { projectSlug, workspaceId: params.get('workspace') }
    }
  } catch { /* fall through to localStorage */ }
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SELECTION_LS_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          const p = parsed as Record<string, unknown>
          return {
            projectSlug: typeof p.projectSlug === 'string' ? p.projectSlug : null,
            workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : null,
          }
        }
      }
    }
  } catch { /* fall through to the empty default */ }
  return { projectSlug: null, workspaceId: null }
}

/**
 * Save the selection to localStorage and to the URL's `?project=&workspace=`
 * params (with replaceState; other params are kept). Query params rather
 * than a path, because the SPA is only served at `/`. Best-effort.
 */
export function persistSelection(projectSlug: string | null, workspaceId: string | null): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SELECTION_LS_KEY, JSON.stringify({ projectSlug, workspaceId }))
    }
  } catch { /* quota/serialization failures are non-fatal */ }
  try {
    if (typeof window !== 'undefined' && window.history) {
      const url = new URL(window.location.href)
      if (projectSlug) url.searchParams.set('project', projectSlug)
      else url.searchParams.delete('project')
      if (workspaceId) url.searchParams.set('workspace', workspaceId)
      else url.searchParams.delete('workspace')
      // Keep the entry's state, where the mobile shell stores its screen.
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
  } catch { /* history failures are non-fatal */ }
}

/** The saved pinned plan-usage metric (a UsageBadge `metricKey`), or null. */
export function loadPinnedUsageMetric(): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PINNED_USAGE_LS_KEY)
      if (raw) return raw
    }
  } catch { /* fall through to the default */ }
  return null
}

/** Save the pinned plan-usage metric (null clears it); best-effort. */
export function persistPinnedUsageMetric(key: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (key) localStorage.setItem(PINNED_USAGE_LS_KEY, key)
    else localStorage.removeItem(PINNED_USAGE_LS_KEY)
  } catch { /* non-fatal — the pin just won't stick */ }
}

/** Saved workspace layouts, dropping any that are invalid. */
export function loadPersistedLayouts(): Record<string, PaneLayout | null> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(LAYOUTS_LS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, PaneLayout | null> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || isPaneLayout(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Saved read-waiting marks (workspaceId → the viewed waitingSinceMs),
 *  dropping non-numbers. syncWaitingRead prunes stale marks. */
export function loadReadWaiting(): Record<string, number> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(READ_WAITING_LS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Save read-waiting marks (best-effort). */
export function persistReadWaiting(marks: Record<string, number>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(READ_WAITING_LS_KEY, JSON.stringify(marks))
  } catch {
    // Non-fatal: the marks just won't persist.
  }
}

/** A chat draft's key: one per conversation, since a workspace can have
 *  several chat panes. */
export function chatDraftKey(workspaceId: string, agentSessionId: string): string {
  return `${workspaceId}|${agentSessionId}`
}

/**
 * One chat pane's input box, kept after the pane unmounts.
 *
 * `sent` is the exact text last sent before the server echoed it. It lets
 * the pane tell whether restored text was already delivered, rather than
 * guessing from whether it matches the last message.
 */
export interface ChatDraft {
  text: string
  sent?: string
}

/** Drafts longer than this stay in memory but aren't saved to localStorage,
 *  where they could exhaust the quota for every other key. */
const MAX_PERSISTED_DRAFT = 64 * 1024

/** Saved chat drafts, dropping invalid entries. syncChatDrafts prunes stale
 *  keys. */
export function loadChatDrafts(): Record<string, ChatDraft> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(CHAT_DRAFTS_LS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, ChatDraft> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const { text, sent } = v as { text?: unknown; sent?: unknown }
      if (typeof text !== 'string') continue
      if (sent !== undefined && typeof sent !== 'string') continue
      if (text === '' && sent === undefined) continue
      out[k] = sent === undefined ? { text } : { text, sent }
    }
    return out
  } catch {
    return {}
  }
}

/** Save chat drafts (best-effort). */
export function persistChatDrafts(drafts: Record<string, ChatDraft>): void {
  try {
    if (typeof localStorage === 'undefined') return
    const storable = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) =>
        d.text.length <= MAX_PERSISTED_DRAFT && (d.sent ?? '').length <= MAX_PERSISTED_DRAFT),
    )
    localStorage.setItem(CHAT_DRAFTS_LS_KEY, JSON.stringify(storable))
  } catch {
    // Non-fatal: the drafts just won't persist.
  }
}

/** Save workspace layouts (best-effort). */
export function persistLayouts(layouts: Record<string, PaneLayout | null>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LAYOUTS_LS_KEY, JSON.stringify(layouts))
  } catch {
    // Non-fatal: the layouts just won't persist.
  }
}

/**
 * Add a special pane (preview, changes or the explorer) to a workspace's
 * layout as a new column. Unchanged if it is already there.
 */
export function injectPaneLeaf(base: PaneLayout | null, target: string): PaneLayout {
  return addColumn(base ?? singleColumn('agent'), target)
}

/** `injectPaneLeaf` for the preview pane. */
export function injectPreviewLeaf(base: PaneLayout | null): PaneLayout {
  return injectPaneLeaf(base, PREVIEW_TARGET)
}

/**
 * Merge the snapshot's provisioning rows with optimistic ones, by
 * workspaceId (the snapshot wins), sorted by createdAt then id. App prunes
 * an optimistic row once the snapshot has it.
 */
export function mergeProvisioning(
  snapshot: ProvisioningWorkspaceEntry[],
  optimistic: ProvisioningWorkspaceEntry[],
): ProvisioningWorkspaceEntry[] {
  const byId = new Map<string, ProvisioningWorkspaceEntry>()
  for (const e of optimistic) byId.set(e.workspaceId, e)
  for (const e of snapshot) byId.set(e.workspaceId, e)
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.workspaceId.localeCompare(b.workspaceId),
  )
}

/**
 * View state of a pane that unmounts when off-screen (Changes, the
 * explorer), kept here so it survives: expanded entries, scroll position,
 * filter, and whether ignored files show. In memory only.
 */
export interface PaneView {
  /** Missing means the pane has not loaded yet (Changes seeds it then). */
  expanded?: string[]
  scroll?: number
  find?: string
  showIgnored?: boolean
}

/** Which pane of which workspace a `paneView` entry belongs to. */
export function paneViewKey(workspaceId: string, pane: string): string {
  return `${workspaceId}|${pane}`
}

/**
 * Whether a workspace is waiting and hasn't been viewed since it started
 * waiting. A read mark stores the waitingSinceMs it saw, so waiting again
 * later flags the workspace again. A missing waitingSinceMs counts as 0.
 */
export function isUnreadWaiting(
  workspace: Pick<WorkspaceListEntry, 'workspaceId' | 'status' | 'waitingSinceMs'>,
  readWaiting: Record<string, number>,
): boolean {
  return workspace.status === 'waiting' && readWaiting[workspace.workspaceId] !== (workspace.waitingSinceMs ?? 0)
}

/**
 * Whether a stopped workspace died unexpectedly and the user hasn't seen it
 * yet. Only the stale reaper sets deathReason. `seen` is stored on the
 * server and resets when the workspace dies again.
 */
export function isUnseenDeath(
  entry: Pick<StoppedWorkspaceEntry, 'deathReason' | 'seen'>,
): boolean {
  return !!entry.deathReason && !entry.seen
}

/**
 * Per-project count of unread waiting workspaces, for the rail's badge.
 * Stopping workspaces (per the server or `pendingDeleteIds`) don't count.
 */
export function unreadWaitingBySlug(
  workspaces: Pick<WorkspaceListEntry, 'workspaceId' | 'projectSlug' | 'status' | 'waitingSinceMs' | 'stopping'>[],
  readWaiting: Record<string, number>,
  pendingDeleteIds: string[] = [],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of workspaces) {
    if (s.stopping || pendingDeleteIds.includes(s.workspaceId)) continue
    if (isUnreadWaiting(s, readWaiting)) {
      out[s.projectSlug] = (out[s.projectSlug] ?? 0) + 1
    }
  }
  return out
}

/**
 * The workspace to select when the selection is left empty without the user
 * choosing it, or null to leave it empty. This covers two cases:
 *   1. the active project changed, and
 *   2. the selected workspace vanished (stopped from the CLI, reaped).
 * Both select the top row, except:
 *   - a create that claimed a prewarmed spare (`claims`) follows the spare's
 *     id once it is listed;
 *   - a selection whose provision is still in flight (`inFlight`) waits,
 *     since a snapshot can briefly miss both its row and its workspace.
 *
 * Null on a first load with nothing saved, and after a deselect.
 */
export function resolveVacantSelection(args: {
  /** The active project as of the previous render; null before there was one. */
  previousProjectSlug: string | null
  activeProjectSlug: string | null
  selectedWorkspaceId: string | null
  /** The sidebar's selectable rows in display order (`sidebarRowIds`). */
  rowIds: string[]
  claims: Record<string, string>
  inFlight: string[]
}): string | null {
  const { previousProjectSlug, activeProjectSlug, selectedWorkspaceId, rowIds, claims, inFlight } = args
  if (!activeProjectSlug) return null
  if (selectedWorkspaceId && rowIds.includes(selectedWorkspaceId)) return null
  const vanished = selectedWorkspaceId !== null
  const switchedProject = previousProjectSlug !== null && previousProjectSlug !== activeProjectSlug
  if (!vanished && !switchedProject) return null
  if (vanished && !switchedProject) {
    const claimed = claims[selectedWorkspaceId]
    if (claimed !== undefined) return rowIds.includes(claimed) ? claimed : null
    if (inFlight.includes(selectedWorkspaceId)) return null
  }
  return rowIds[0] ?? null
}

/** Sections of the settings modal (left-nav entries). 'server' shows only in the desktop shell. */
export type SettingsSection =
  | 'general' | 'shortcuts' | 'credentials' | 'project' | 'userDockerfile' | 'server'

/**
 * What the create dialog was opened for. `editId` edits that queued entry;
 * `parent` (a workspace or queued entry id) sets Start to after that one
 * stops; with neither, Start is "Now".
 */
export interface CreateWorkspaceDialogOpts {
  projectSlug: string
  parent?: string
  editId?: string
  /** Reopen a saved draft (docs/draft-workspaces.md) on its fields. */
  draftId?: string
  /** Focus the prompt field. */
  focus?: 'prompt'
}

/** Client-side UI state. Server state lives in the snapshot. */
interface UiState {
  /** Project whose workspaces the sidebar is scoped to (rail selection). */
  activeProjectSlug: string | null
  /** Workspace shown in the main pane. */
  selectedWorkspaceId: string | null
  /** Bumped when a workspace is selected or opened; the view then focuses
   *  its primary pane. */
  focusNonce: number
  /** Per-workspace counter; bumping one remounts and reattaches that
   *  workspace's terminals (e.g. after a restart). */
  terminalNonces: Record<string, number>
  /** Per-workspace pane layout. A missing key means the default single
   *  column; null means explicitly emptied. */
  layouts: Record<string, PaneLayout | null>
  /** Per-workspace port the preview pane shows; missing means the first
   *  forwarded port. */
  previewPort: Record<string, number>
  /** Show another forwarded port in the preview pane. */
  setPreviewPort: (workspaceId: string, containerPort: number) => void
  /** Open or focus the preview pane, setting its port if unset. */
  openPreview: (workspaceId: string, containerPort?: number) => void
  /** Open or focus a workspace's Changes pane. */
  openChanges: (workspaceId: string) => void
  /** Open or focus a workspace's file explorer. */
  openFiles: (workspaceId: string) => void
  /** Open or focus one file's editor pane (see `placeFile`). */
  openFile: (workspaceId: string, path: string) => void
  /** Open files with unsaved text, by `fileKey`. Drives the tab's dirty dot
   *  and the page's unload warning. */
  dirtyFiles: Record<string, true>
  setFileDirty: (workspaceId: string, path: string, dirty: boolean) => void
  /** After a file or folder rename, move its open panes (and those under
   *  it) and their dirty marks to the new path. */
  renameFiles: (workspaceId: string, from: string, to: string) => void
  /** Close the editor panes of these files. */
  closeFiles: (workspaceId: string, paths: string[]) => void
  /** Whether the workspace sidebar is shown (desktop only). */
  sidebarOpen: boolean
  /** The sidebar's width in px, set by its drag handle (desktop only).
   *  Saved and clamped. */
  sidebarWidth: number
  setSidebarWidth: (px: number) => void
  /** Which mobile screen is showing. Saved. */
  mobileScreen: MobileScreen
  /** Move to a mobile screen directly. Back buttons use `goBackScreen`
   *  instead, to keep browser history in step. */
  setMobileScreen: (screen: MobileScreen) => void
  /** Light/dark preference (see #lib/theme). */
  themePref: ThemePref
  setThemePref: (pref: ThemePref) => void
  /** Whether the attention chime plays when a workspace flips to waiting. */
  soundEnabled: boolean
  setSoundEnabled: (enabled: boolean) => void
  /** Editor font size in px for all file panes. Saved and clamped. */
  editorFontSize: number
  setEditorFontSize: (px: number) => void
  /** Whether chat panes span the full pane width instead of a centered
   *  column. Saved; off by default. */
  chatFullWidth: boolean
  setChatFullWidth: (full: boolean) => void
  /** Tiles or tabs. Saved; small screens default to tabs. */
  viewMode: ViewMode
  /** Plan-usage metric pinned to the sidebar pill (a UsageBadge
   *  `metricKey`); null shows the tightest limit. Saved. */
  pinnedUsageMetric: string | null
  setPinnedUsageMetric: (key: string | null) => void
  /** Per-workspace active pane: the visible tab in tabs mode, the
   *  last-focused pane in tiles mode. Cycle shortcuts start from it. */
  activeTabs: Record<string, string>
  /** Per-workspace branch the Changes pane diffs against; absent means the
   *  workspace's fork base. In memory only. */
  changesBase: Record<string, string>
  /** Set a workspace's Changes base branch; undefined resets it. */
  setChangesBase: (workspaceId: string, branch: string | undefined) => void
  /** View state of panes that unmount off-screen, by `paneViewKey`. */
  paneView: Record<string, PaneView>
  /** Merge into a pane's view state. */
  setPaneView: (key: string, patch: PaneView) => void
  /** Unsent chat messages, by `chatDraftKey`. Kept here rather than in
   *  WorkspaceChat so a draft outlives its pane, and saved so it survives a
   *  reload. */
  chatDrafts: Record<string, ChatDraft>
  /** Set (or, with '', clear) a conversation's draft. Also drops any `sent`
   *  marker, since the text no longer matches what was sent. */
  setChatDraft: (workspaceId: string, agentSessionId: string, text: string) => void
  /** Record the text just sent, or clear it (undefined) once the server
   *  echoes it. */
  setChatSent: (workspaceId: string, agentSessionId: string, sent: string | undefined) => void
  /** Drop drafts of workspaces the snapshot no longer lists. Drafts of
   *  inactive sessions are kept, since a session can come back. */
  syncChatDrafts: (workspaceIds: string[]) => void
  /** One-time request from the open-files shortcut to focus the explorer's
   *  filter. The explorer clears it once handled. */
  filesFindPending: boolean
  setFilesFindPending: (pending: boolean) => void
  /** Optimistic provisioning rows, shown until the snapshot's
   *  `provisioning[]` lists the id. */
  optimisticProvisioning: ProvisioningWorkspaceEntry[]
  /** Create id → the prewarmed spare it claimed, from the snapshot row
   *  (`claimedId`) or the create's result. Lets the selection follow the
   *  create (`resolveVacantSelection`). */
  claims: Record<string, string>
  recordClaim: (workspaceId: string, claimedId: string) => void
  /** Drop a claim once followed or no longer valid. */
  forgetClaim: (workspaceId: string) => void
  /** Provisions started by this tab whose request hasn't finished. */
  inFlightProvisions: string[]
  setProvisionInFlight: (workspaceId: string, inFlight: boolean) => void
  /** Workspaces whose stop was confirmed, shown as stopping until the
   *  snapshot drops them. */
  pendingDeleteIds: string[]
  /** Just-stopped workspaces, shown in the stopped list until the server's
   *  list includes them. */
  optimisticStopped: StoppedWorkspaceEntry[]
  /** Read marks: workspaceId → the waitingSinceMs the user viewed (see
   *  isUnreadWaiting). Saved; syncWaitingRead drops stale marks. */
  readWaiting: Record<string, number>
  /** Shortcut bindings (command id → chord): the defaults until the saved
   *  overrides load. */
  bindings: BindingMap
  /** Replace the whole binding map, e.g. with the saved overrides. */
  setBindings: (bindings: BindingMap) => void
  /** Rebind a single command. */
  setBinding: (id: ShortcutId, chord: Chord) => void
  /** Restore every command to its factory default. */
  resetBindings: () => void
  /** True while settings is recording a chord, so shortcuts don't fire. */
  recordingShortcut: boolean
  setRecordingShortcut: (recording: boolean) => void
  /** Whether the settings modal is open. Kept here so any component can
   *  open settings onto a section. */
  settingsOpen: boolean
  /** Section the settings modal shows; kept across open and close. */
  settingsSection: SettingsSection
  /** Tool whose sign-in form the credentials section expands, when opened
   *  from a "Sign in" button. Cleared on close. */
  settingsFocusTool: AgentTool | null
  /** Project whose git-credential row the credentials section scrolls to,
   *  when opened from "Add git authentication". Cleared on close. */
  settingsFocusProject: string | null
  /** Open settings, optionally onto a section, tool or project. Without
   *  args it reopens the last section. */
  openSettings: (section?: SettingsSection, focusTool?: AgentTool, focusProject?: string) => void
  closeSettings: () => void
  setSettingsSection: (section: SettingsSection) => void
  /** The create dialog's options when open. Mounted once in App and opened
   *  from anywhere through here. */
  createWorkspaceDialog: CreateWorkspaceDialogOpts | null
  openCreateWorkspace: (opts: CreateWorkspaceDialogOpts) => void
  closeCreateWorkspace: () => void
  /** A queued entry just created or moved from the create dialog, and its
   *  new parent. The sidebar expands its set once the snapshot shows it
   *  there, then clears this. */
  revealQueued: { id: string; parent: string } | null
  setRevealQueued: (reveal: { id: string; parent: string } | null) => void
  /** Whether the stopped-workspaces overlay is open (for the active project). */
  stoppedOverlayOpen: boolean
  /** The workspace the overlay opens onto, when opened from that
   *  workspace's row. Cleared on close. */
  stoppedOverlayFocus: string | null
  openStoppedOverlay: (workspaceId?: string) => void
  closeStoppedOverlay: () => void
  /** Whether the skills overlay is open (for the active project). */
  skillsOverlayOpen: boolean
  openSkillsOverlay: () => void
  closeSkillsOverlay: () => void
  /** Add an optimistic provisioning row (deduplicated by id). */
  addOptimisticProvisioning: (entry: ProvisioningWorkspaceEntry) => void
  /** Update an optimistic row's message or error, if it exists. */
  updateOptimisticProvisioning: (
    workspaceId: string,
    patch: { message?: string; error?: string },
  ) => void
  /** Drop an optimistic row, once the snapshot has it or on dismiss. */
  removeOptimisticProvisioning: (workspaceId: string) => void
  setActiveProject: (slug: string | null) => void
  /** Like `setActiveProject`, for when App picks a project itself. Leaves
   *  the mobile screen alone (see MobileScreen). */
  restoreActiveProject: (slug: string) => void
  /** The user picked a workspace; on mobile this moves to the pane screen. */
  selectWorkspace: (id: string | null) => void
  /** Like `selectWorkspace`, for when the app picks a workspace itself (see
   *  resolveVacantSelection, successorRow). Leaves the mobile screen alone. */
  autoSelectWorkspace: (id: string) => void
  /** Jump to a specific workspace, switching the active project to match. */
  openWorkspace: (projectSlug: string, workspaceId: string) => void
  reconnectTerminal: (workspaceId: string) => void
  /** Replace a workspace's layout (see #lib/layout). */
  setWorkspaceLayout: (workspaceId: string, layout: PaneLayout | null) => void
  toggleSidebar: () => void
  setViewMode: (mode: ViewMode) => void
  /** Record a workspace's active pane without moving focus, for focus the
   *  DOM already moved (a click into a pane). */
  setActiveTab: (workspaceId: string, target: string) => void
  /** Make a pane active and focus it, for tab clicks and shortcuts. */
  focusTerminal: (workspaceId: string, target: string) => void
  /** Mark a workspace as stopping, optimistically. */
  beginDelete: (workspaceId: string) => void
  /** Clear the stopping mark, when the stop fails or the snapshot drops the
   *  workspace. */
  endDelete: (workspaceId: string) => void
  /** Optimistically add a just-stopped workspace to the stopped list. */
  addOptimisticStopped: (entry: StoppedWorkspaceEntry) => void
  /** Drop an optimistic stopped entry, once the server's list has it or on
   *  restart. */
  removeOptimisticStopped: (workspaceId: string) => void
  /** Mark a waiting workspace as viewed. Pass its waitingSinceMs (0 if
   *  missing). */
  markWaitingRead: (workspaceId: string, waitingSinceMs: number) => void
  /** Drop read marks that no longer match a waiting workspace. Only keeps the
   *  saved map from growing; isUnreadWaiting is correct without it. */
  syncWaitingRead: (waiting: { workspaceId: string; waitingSinceMs: number }[]) => void
}

/** Open a special pane as its own column (if not already open) and focus it. */
function openSpecialPane(s: UiState, workspaceId: string, target: string): Partial<UiState> {
  const base = workspaceId in s.layouts ? s.layouts[workspaceId] : singleColumn('agent')
  const injected = injectPaneLeaf(base, target)
  return {
    layouts: { ...s.layouts, [workspaceId]: withActive(injected, target) },
    activeTabs: { ...s.activeTabs, [workspaceId]: target },
    focusNonce: s.focusNonce + 1,
  }
}

const initialSelection = loadSelection()

/**
 * Whether shortcuts are off: while settings records a rebind, or while the
 * create dialog is open (where they could discard the prompt or queue a
 * stop, and on macOS Option chords type characters such as ñ).
 */
export function shortcutsSuspended(state: Pick<UiState, 'recordingShortcut' | 'createWorkspaceDialog'>): boolean {
  return state.recordingShortcut || state.createWorkspaceDialog !== null
}

export const useUiStore = create<UiState>((set) => ({
  activeProjectSlug: initialSelection.projectSlug,
  selectedWorkspaceId: initialSelection.workspaceId,
  focusNonce: 0,
  terminalNonces: {},
  layouts: loadPersistedLayouts(),
  previewPort: {},
  sidebarOpen: true,
  sidebarWidth: loadSidebarWidth(),
  mobileScreen: loadMobileScreen(),
  setMobileScreen: (screen) => set((s) => (s.mobileScreen === screen ? s : { mobileScreen: screen })),
  themePref: loadThemePref(),
  soundEnabled: loadSoundEnabled(),
  editorFontSize: loadEditorFontSize(),
  chatFullWidth: loadChatFullWidth(),
  viewMode: loadViewMode(),
  pinnedUsageMetric: loadPinnedUsageMetric(),
  activeTabs: {},
  changesBase: {},
  paneView: {},
  filesFindPending: false,
  dirtyFiles: {},
  chatDrafts: loadChatDrafts(),
  optimisticProvisioning: [],
  pendingDeleteIds: [],
  optimisticStopped: [],
  readWaiting: loadReadWaiting(),
  bindings: DEFAULT_BINDINGS,
  setBindings: (bindings) => set({ bindings }),
  setBinding: (id, chord) => set((s) => ({ bindings: { ...s.bindings, [id]: chord } })),
  resetBindings: () => set({ bindings: DEFAULT_BINDINGS }),
  recordingShortcut: false,
  setRecordingShortcut: (recording) => set({ recordingShortcut: recording }),
  settingsOpen: false,
  settingsSection: 'general',
  settingsFocusTool: null,
  settingsFocusProject: null,
  openSettings: (section, focusTool, focusProject) => set((s) => ({
    settingsOpen: true,
    settingsSection: section ?? s.settingsSection,
    settingsFocusTool: focusTool ?? null,
    settingsFocusProject: focusProject ?? null,
  })),
  closeSettings: () => set({ settingsOpen: false, settingsFocusTool: null, settingsFocusProject: null }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  createWorkspaceDialog: null,
  openCreateWorkspace: (opts) => set({ createWorkspaceDialog: opts }),
  closeCreateWorkspace: () => set({ createWorkspaceDialog: null }),
  revealQueued: null,
  setRevealQueued: (reveal) => set({ revealQueued: reveal }),
  stoppedOverlayOpen: false,
  stoppedOverlayFocus: null,
  openStoppedOverlay: (workspaceId) => set({
    stoppedOverlayOpen: true,
    stoppedOverlayFocus: workspaceId ?? null,
  }),
  closeStoppedOverlay: () => set({ stoppedOverlayOpen: false, stoppedOverlayFocus: null }),

  skillsOverlayOpen: false,
  openSkillsOverlay: () => set({ skillsOverlayOpen: true }),
  closeSkillsOverlay: () => set({ skillsOverlayOpen: false }),
  addOptimisticProvisioning: (entry) => set((s) => (
    s.optimisticProvisioning.some((e) => e.workspaceId === entry.workspaceId)
      ? s
      : { optimisticProvisioning: [...s.optimisticProvisioning, entry] }
  )),
  updateOptimisticProvisioning: (workspaceId, patch) => set((s) => (
    s.optimisticProvisioning.some((e) => e.workspaceId === workspaceId)
      ? {
          optimisticProvisioning: s.optimisticProvisioning.map((e) =>
            e.workspaceId === workspaceId ? { ...e, ...patch } : e),
        }
      : s
  )),
  removeOptimisticProvisioning: (workspaceId) => set((s) => (
    s.optimisticProvisioning.some((e) => e.workspaceId === workspaceId)
      ? { optimisticProvisioning: s.optimisticProvisioning.filter((e) => e.workspaceId !== workspaceId) }
      : s
  )),
  claims: {},
  forgetClaim: (workspaceId) => set((s) => {
    if (!(workspaceId in s.claims)) return s
    const { [workspaceId]: _, ...claims } = s.claims
    return { claims }
  }),
  inFlightProvisions: [],
  setProvisionInFlight: (workspaceId, inFlight) => set((s) => (
    s.inFlightProvisions.includes(workspaceId) === inFlight
      ? s
      : {
          inFlightProvisions: inFlight
            ? [...s.inFlightProvisions, workspaceId]
            : s.inFlightProvisions.filter((id) => id !== workspaceId),
        }
  )),
  recordClaim: (workspaceId, claimedId) => set((s) => (
    s.claims[workspaceId] === claimedId ? s : { claims: { ...s.claims, [workspaceId]: claimedId } }
  )),
  // Switching projects clears the selection. On mobile it shows the
  // project's workspace list, or the project list when cleared.
  setActiveProject: (slug) => set({
    activeProjectSlug: slug,
    selectedWorkspaceId: null,
    mobileScreen: slug ? 'workspaces' : 'projects',
  }),
  restoreActiveProject: (slug) => set({ activeProjectSlug: slug, selectedWorkspaceId: null }),
  // A deselect (null) doesn't change the mobile screen.
  selectWorkspace: (id) => set((s) => ({
    selectedWorkspaceId: id,
    focusNonce: s.focusNonce + 1,
    mobileScreen: id ? 'pane' : s.mobileScreen,
  })),
  autoSelectWorkspace: (id) => set((s) => ({ selectedWorkspaceId: id, focusNonce: s.focusNonce + 1 })),
  openWorkspace: (projectSlug, workspaceId) => set((s) => ({
    activeProjectSlug: projectSlug,
    selectedWorkspaceId: workspaceId,
    focusNonce: s.focusNonce + 1,
    mobileScreen: 'pane',
  })),
  reconnectTerminal: (workspaceId) => set((s) => ({
    terminalNonces: { ...s.terminalNonces, [workspaceId]: (s.terminalNonces[workspaceId] ?? 0) + 1 },
  })),
  setWorkspaceLayout: (workspaceId, layout) => set((s) => ({
    layouts: { ...s.layouts, [workspaceId]: layout },
  })),
  setPreviewPort: (workspaceId, containerPort) => set((s) => (
    s.previewPort[workspaceId] === containerPort
      ? s
      : { previewPort: { ...s.previewPort, [workspaceId]: containerPort } }
  )),
  openPreview: (workspaceId, containerPort) => set((s) => {
    const base = workspaceId in s.layouts ? s.layouts[workspaceId] : singleColumn('agent')
    const previewPort = containerPort !== undefined && s.previewPort[workspaceId] === undefined
      ? { ...s.previewPort, [workspaceId]: containerPort }
      : s.previewPort
    return {
      layouts: { ...s.layouts, [workspaceId]: injectPreviewLeaf(base) },
      previewPort,
      activeTabs: { ...s.activeTabs, [workspaceId]: PREVIEW_TARGET },
      focusNonce: s.focusNonce + 1,
    }
  }),
  openChanges: (workspaceId) => set((s) => openSpecialPane(s, workspaceId, CHANGES_TARGET)),
  openFiles: (workspaceId) => set((s) => openSpecialPane(s, workspaceId, FILES_TARGET)),
  openFile: (workspaceId, path) => set((s) => {
    const target = fileTarget(path)
    const base = workspaceId in s.layouts ? s.layouts[workspaceId] : singleColumn('agent')
    const placed = placeFile(base ?? [], target, s.activeTabs[workspaceId])
    return {
      layouts: { ...s.layouts, [workspaceId]: withActive(placed, target) },
      activeTabs: { ...s.activeTabs, [workspaceId]: target },
      focusNonce: s.focusNonce + 1,
    }
  }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (px) => set((s) => {
    const width = clampSidebarWidth(px)
    return width === s.sidebarWidth ? s : { sidebarWidth: width }
  }),
  setThemePref: (pref) => {
    persistThemePref(pref)
    applyThemeAttribute(pref)
    set({ themePref: pref })
  },
  setSoundEnabled: (enabled) => {
    persistSoundEnabled(enabled)
    set({ soundEnabled: enabled })
  },
  setChatFullWidth: (full) => {
    persistChatFullWidth(full)
    set({ chatFullWidth: full })
  },
  setEditorFontSize: (px) => {
    const size = clampEditorFontSize(px)
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(EDITOR_FONT_LS_KEY, String(size))
    } catch { /* non-fatal — the size just won't stick */ }
    set({ editorFontSize: size })
  },
  setViewMode: (mode) => {
    persistViewMode(mode)
    set({ viewMode: mode })
  },
  setPinnedUsageMetric: (key) => {
    persistPinnedUsageMetric(key)
    set({ pinnedUsageMetric: key })
  },
  setActiveTab: (workspaceId, target) => set((s) => (
    s.activeTabs[workspaceId] === target
      ? s
      : { activeTabs: { ...s.activeTabs, [workspaceId]: target } }
  )),
  setChangesBase: (workspaceId, branch) => set((s) => {
    const next = { ...s.changesBase }
    if (branch) next[workspaceId] = branch
    else delete next[workspaceId]
    return { changesBase: next }
  }),
  setPaneView: (key, patch) => set((s) => {
    const cur = s.paneView[key] ?? {}
    const next = { ...cur, ...patch }
    const same = (Object.keys(patch) as Array<keyof PaneView>).every((k) => cur[k] === next[k])
    return same ? s : { paneView: { ...s.paneView, [key]: next } }
  }),
  setFilesFindPending: (pending) => set((s) => (
    s.filesFindPending === pending ? s : { filesFindPending: pending }
  )),
  setFileDirty: (workspaceId, path, dirty) => set((s) => {
    const key = fileKey(workspaceId, path)
    if ((s.dirtyFiles[key] === true) === dirty) return s
    const next = { ...s.dirtyFiles }
    if (dirty) next[key] = true
    else delete next[key]
    return { dirtyFiles: next }
  }),
  renameFiles: (workspaceId, from, to) => set((s) => {
    const cur = workspaceId in s.layouts ? s.layouts[workspaceId] : null
    const layout = cur && renameTargets(cur, fileTarget(from), fileTarget(to))
    const renamed = (key: string): string => {
      const prefix = fileKey(workspaceId, from)
      return key === prefix || key.startsWith(`${prefix}/`) ? fileKey(workspaceId, to) + key.slice(prefix.length) : key
    }
    const dirtyFiles = Object.fromEntries(Object.keys(s.dirtyFiles).map((k) => [renamed(k), true as const]))
    const active = s.activeTabs[workspaceId]
    const activeTabs = active === undefined ? s.activeTabs : {
      ...s.activeTabs,
      [workspaceId]: renameTargets([{ tabs: [active], active }], fileTarget(from), fileTarget(to))[0].active,
    }
    return {
      dirtyFiles,
      activeTabs,
      ...(layout && layout !== cur ? { layouts: { ...s.layouts, [workspaceId]: layout } } : {}),
    }
  }),
  closeFiles: (workspaceId, paths) => set((s) => {
    let layout = workspaceId in s.layouts ? s.layouts[workspaceId] : null
    for (const p of paths) layout = layout && removeTarget(layout, fileTarget(p))
    const dirtyFiles = { ...s.dirtyFiles }
    for (const p of paths) delete dirtyFiles[fileKey(workspaceId, p)]
    return {
      dirtyFiles,
      ...(layout ? { layouts: { ...s.layouts, [workspaceId]: layout } } : {}),
    }
  }),
  setChatDraft: (workspaceId, agentSessionId, text) => set((s) => {
    const key = chatDraftKey(workspaceId, agentSessionId)
    const cur = s.chatDrafts[key]
    if ((cur?.text ?? '') === text) return s
    // New text drops the `sent` marker.
    const next = { ...s.chatDrafts }
    if (text === '') delete next[key]
    else next[key] = { text }
    return { chatDrafts: next }
  }),
  setChatSent: (workspaceId, agentSessionId, sent) => set((s) => {
    const key = chatDraftKey(workspaceId, agentSessionId)
    const cur = s.chatDrafts[key]
    if ((cur?.sent) === sent) return s
    const next = { ...s.chatDrafts }
    // Don't keep an empty draft with nothing in flight.
    if (sent === undefined && (cur?.text ?? '') === '') delete next[key]
    else if (sent === undefined) next[key] = { text: cur?.text ?? '' }
    else next[key] = { text: cur?.text ?? '', sent }
    return { chatDrafts: next }
  }),
  syncChatDrafts: (workspaceIds) => set((s) => {
    const live = new Set(workspaceIds)
    const kept: Record<string, ChatDraft> = {}
    for (const [key, draft] of Object.entries(s.chatDrafts)) {
      if (live.has(key.slice(0, key.indexOf('|')))) kept[key] = draft
    }
    return Object.keys(kept).length === Object.keys(s.chatDrafts).length ? s : { chatDrafts: kept }
  }),
  focusTerminal: (workspaceId, target) => set((s) => {
    // Also make it its column's visible tab. `layouts` changes only if
    // withActive changed something, so a plain focus doesn't rewrite storage.
    const cur = workspaceId in s.layouts ? s.layouts[workspaceId] : singleColumn('agent')
    const next = withActive(cur, target)
    return {
      ...(next === cur ? {} : { layouts: { ...s.layouts, [workspaceId]: next } }),
      activeTabs: { ...s.activeTabs, [workspaceId]: target },
      focusNonce: s.focusNonce + 1,
    }
  }),
  beginDelete: (workspaceId) => set((s) => (
    s.pendingDeleteIds.includes(workspaceId)
      ? s
      : { pendingDeleteIds: [...s.pendingDeleteIds, workspaceId] }
  )),
  endDelete: (workspaceId) => set((s) => (
    s.pendingDeleteIds.includes(workspaceId)
      ? { pendingDeleteIds: s.pendingDeleteIds.filter((id) => id !== workspaceId) }
      : s
  )),
  addOptimisticStopped: (entry) => set((s) => (
    s.optimisticStopped.some((e) => e.workspaceId === entry.workspaceId)
      ? s
      : { optimisticStopped: [entry, ...s.optimisticStopped] }
  )),
  removeOptimisticStopped: (workspaceId) => set((s) => (
    s.optimisticStopped.some((e) => e.workspaceId === workspaceId)
      ? { optimisticStopped: s.optimisticStopped.filter((e) => e.workspaceId !== workspaceId) }
      : s
  )),
  markWaitingRead: (workspaceId, waitingSinceMs) => set((s) => (
    s.readWaiting[workspaceId] === waitingSinceMs
      ? s
      : { readWaiting: { ...s.readWaiting, [workspaceId]: waitingSinceMs } }
  )),
  syncWaitingRead: (waiting) => set((s) => {
    const current = new Map(waiting.map((w) => [w.workspaceId, w.waitingSinceMs]))
    const kept: Record<string, number> = {}
    for (const [id, since] of Object.entries(s.readWaiting)) {
      if (current.get(id) === since) kept[id] = since
    }
    return Object.keys(kept).length === Object.keys(s.readWaiting).length ? s : { readWaiting: kept }
  }),
}))

// Save layouts. A restart keeps the workspace id, so the layout survives it.
useUiStore.subscribe((state, prev) => {
  if (state.layouts !== prev.layouts) persistLayouts(state.layouts)
})

// Save the sidebar width; small enough to write on every drag step.
useUiStore.subscribe((state, prev) => {
  if (state.sidebarWidth !== prev.sidebarWidth) persistSidebarWidth(state.sidebarWidth)
})

// Save the selection and mirror it into the URL, so a link is shareable.
useUiStore.subscribe((state, prev) => {
  if (
    state.activeProjectSlug !== prev.activeProjectSlug
    || state.selectedWorkspaceId !== prev.selectedWorkspaceId
  ) {
    persistSelection(state.activeProjectSlug, state.selectedWorkspaceId)
  }
})

// Save read marks so viewed waiting workspaces don't flag again on reload.
useUiStore.subscribe((state, prev) => {
  if (state.readWaiting !== prev.readWaiting) persistReadWaiting(state.readWaiting)
})

/** Delay before saving chat drafts after a change. */
const CHAT_DRAFT_PERSIST_MS = 400

let draftTimer: ReturnType<typeof setTimeout> | undefined
let unwrittenDrafts: Record<string, ChatDraft> | null = null

/** Save any pending draft change now, e.g. when the page is closing. Does
 *  nothing if there is none. */
export function flushChatDrafts(): void {
  if (draftTimer !== undefined) {
    clearTimeout(draftTimer)
    draftTimer = undefined
  }
  if (unwrittenDrafts === null) return
  persistChatDrafts(unwrittenDrafts)
  unwrittenDrafts = null
}

// Save drafts on a trailing timer, since they change on every keystroke.
useUiStore.subscribe((state, prev) => {
  if (state.chatDrafts === prev.chatDrafts) return
  unwrittenDrafts = state.chatDrafts
  if (draftTimer !== undefined) clearTimeout(draftTimer)
  draftTimer = setTimeout(flushChatDrafts, CHAT_DRAFT_PERSIST_MS)
})

if (typeof window !== 'undefined') {
  // Warn before leaving with unsaved editor text.
  window.addEventListener('beforeunload', (e) => {
    if (Object.keys(useUiStore.getState().dirtyFiles).length > 0) e.preventDefault()
  })
  // Flush drafts on pagehide, and on a hidden visibilitychange, since some
  // mobile and bfcache paths skip pagehide.
  window.addEventListener('pagehide', flushChatDrafts)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushChatDrafts()
  })
}
// Save the mobile screen so a reload returns to it.
useUiStore.subscribe((state, prev) => {
  if (state.mobileScreen !== prev.mobileScreen) persistMobileScreen(state.mobileScreen)
})
