import { create } from 'zustand'
import { addColumn, isPaneLayout, removeTarget, renameTargets, singleColumn, withActive, type PaneLayout } from '#lib/layout'
import { PREVIEW_TARGET } from '#lib/preview'
import { FILES_TARGET, fileKey, fileTarget, placeFile } from '#lib/files'
import { DEFAULT_BINDINGS, type BindingMap, type Chord, type ShortcutId } from '#lib/shortcuts'
import { applyThemeAttribute, type ThemePref } from '#lib/theme'
import type {
  AgentTool, ProvisioningWorkspaceEntry, ServerSnapshot, StoppedWorkspaceEntry, WorkspaceListEntry,
} from '@yaac/shared/types'

/** Desktop sidebar width in px: the default and the drag bounds. */
export const DEFAULT_SIDEBAR_WIDTH = 256
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 640

/** Clamp a sidebar width to the bounds. */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SIDEBAR_WIDTH
  return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, px)))
}

/** File-pane editor font size, in px, and the range the A−/A+ steps stay in. */
export const DEFAULT_EDITOR_FONT_SIZE = 12
export const MIN_EDITOR_FONT_SIZE = 9
export const MAX_EDITOR_FONT_SIZE = 24

const clampEditorFontSize = (px: number): number =>
  Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Math.round(px)))

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
 * The mobile screen of a first visit, when none is saved: a `?workspace=`
 * link opens the pane. Only a first visit can go by the URL, since
 * persistSelection always writes the params.
 */
export function defaultMobileScreen(): MobileScreen {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('workspace')) return 'pane'
    if (params.get('project')) return 'workspaces'
  } catch { /* no window: fall through to the default */ }
  return 'projects'
}

/** How a workspace's panes are shown: side-by-side columns, or one tab at a
 *  time. */
export type ViewMode = 'tiles' | 'tabs'

/** The view mode of a first run, by viewport width. */
export function defaultViewMode(viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1440): ViewMode {
  return viewportWidth < 1024 ? 'tabs' : 'tiles'
}

const SELECTION_LS_KEY = 'yaac.selection.v1'

/** The selected project and workspace, saved so a reload or a shared link
 *  reopens the same view. */
export interface PersistedSelection {
  projectId: string | null
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
      const projectId = params.get('project')
      if (projectId) return { projectId, workspaceId: params.get('workspace') }
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
            projectId: typeof p.projectId === 'string' ? p.projectId : null,
            workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : null,
          }
        }
      }
    }
  } catch { /* fall through to the empty default */ }
  return { projectId: null, workspaceId: null }
}

/**
 * Save the selection to localStorage and to the URL's `?project=&workspace=`
 * params (with replaceState; other params are kept). Query params rather
 * than a path, because the SPA is only served at `/`. Best-effort.
 */
export function persistSelection(projectId: string | null, workspaceId: string | null): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SELECTION_LS_KEY, JSON.stringify({ projectId, workspaceId }))
    }
  } catch { /* quota/serialization failures are non-fatal */ }
  try {
    if (typeof window !== 'undefined' && window.history) {
      const url = new URL(window.location.href)
      if (projectId) url.searchParams.set('project', projectId)
      else url.searchParams.delete('project')
      if (workspaceId) url.searchParams.set('workspace', workspaceId)
      else url.searchParams.delete('workspace')
      // Keep the entry's state, where the mobile shell stores its screen.
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
  } catch { /* history failures are non-fatal */ }
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

/**
 * How one store field is saved in localStorage. Each field has its own key,
 * which is the key existing installs already hold. `parse` returns undefined
 * for a value it rejects, leaving the default; `serialize` (default
 * `String`) returning null removes the key.
 */
interface Persisted<T> {
  key: string
  parse: (raw: string) => T | undefined
  serialize?: (value: T) => string | null
}

const flag = (key: string): Persisted<boolean> => ({
  key,
  parse: (raw) => (raw === '1' ? true : raw === '0' ? false : undefined),
  serialize: (v) => (v ? '1' : '0'),
})

const oneOf = <T extends string>(key: string, values: readonly T[]): Persisted<T> => ({
  key,
  parse: (raw) => values.find((v) => v === raw),
})

const number = (key: string, clamp: (n: number) => number): Persisted<number> => ({
  key,
  parse: (raw) => (raw.trim() !== '' && Number.isFinite(Number(raw)) ? clamp(Number(raw)) : undefined),
})

/** A JSON object, keeping only the entries `keep` accepts. */
const jsonRecord = <V>(key: string, keep: (v: unknown) => v is V): Persisted<Record<string, V>> => ({
  key,
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => keep(v)))
  },
  serialize: JSON.stringify,
})

function isChatDraft(v: unknown): v is ChatDraft {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const { text, sent } = v as { text?: unknown; sent?: unknown }
  return typeof text === 'string' && (sent === undefined || typeof sent === 'string')
    && (text !== '' || sent !== undefined)
}

/**
 * How a file pane shows its changes since the diff base: not at all, its
 * added lines tinted, removed lines too (read-only, between the editable
 * ones), or only the changed stretches with the rest folded away.
 */
export const FILE_DIFF_MODES = ['plain', 'added', 'inline', 'changes'] as const
export type FileDiffMode = typeof FILE_DIFF_MODES[number]

/** The store fields saved across reloads. */
const PERSISTED: { [K in keyof UiState]?: Persisted<UiState[K]> } = {
  // A restart keeps the workspace id, so its layout survives it.
  layouts: jsonRecord('yaac.layouts.v2', isPaneLayout),
  viewMode: oneOf('yaac.viewmode.v1', ['tiles', 'tabs']),
  readWaiting: jsonRecord('yaac.readwaiting.v1', (v): v is number => typeof v === 'number'),
  pinnedUsageMetric: { key: 'yaac.pinnedusage.v1', parse: (raw) => raw || undefined, serialize: (v) => v },
  soundEnabled: flag('yaac.sound.v1'),
  chatDrafts: {
    ...jsonRecord('yaac.chatdrafts.v1', isChatDraft),
    serialize: (drafts) => JSON.stringify(Object.fromEntries(Object.entries(drafts).filter(([, d]) =>
      d.text.length <= MAX_PERSISTED_DRAFT && (d.sent ?? '').length <= MAX_PERSISTED_DRAFT))),
  },
  mobileScreen: oneOf('yaac.mobilescreen.v1', ['projects', 'workspaces', 'pane']),
  sidebarWidth: number('yaac.sidebarwidth.v1', clampSidebarWidth),
  stoppedExpanded: flag('yaac.stoppedexpanded.v1'),
  editorFontSize: number('yaac.editorfontsize.v1', clampEditorFontSize),
  fileDiffMode: oneOf('yaac.filediffmode.v1', FILE_DIFF_MODES),
  chatFullWidth: flag('yaac.chatfullwidth.v1'),
  chatCondensed: flag('yaac.chatcondensed.v1'),
  // index.html reads this key before first paint, to avoid a theme flash.
  themePref: oneOf('yaac.theme.v1', ['system', 'light', 'dark']),
}

const persistedFields = Object.keys(PERSISTED) as (keyof UiState)[]

/** Every saved field that is present and valid. */
export function loadPersisted(): Partial<UiState> {
  const out: Record<string, unknown> = {}
  for (const field of persistedFields) {
    const p = PERSISTED[field] as Persisted<unknown>
    try {
      const raw = localStorage.getItem(p.key)
      const value = raw === null ? undefined : p.parse(raw)
      if (value !== undefined) out[field] = value
    } catch { /* no or unreadable storage: keep the default */ }
  }
  return out
}

function savePersisted(field: keyof UiState, value: unknown): void {
  const p = PERSISTED[field] as Persisted<unknown>
  try {
    const raw = (p.serialize ?? String)(value)
    if (raw === null) localStorage.removeItem(p.key)
    else localStorage.setItem(p.key, raw)
  } catch { /* non-fatal: the value just won't survive a reload */ }
}

/**
 * A workspace's layout. A workspace with none stored shows the single pane
 * `fallback`. Callers that don't know the workspace's mode use `agent`; in an
 * `acp` workspace the window sync (`syncPaneLayout`) then puts the chat pane
 * in its place.
 */
export function layoutOf(
  layouts: Record<string, PaneLayout>,
  workspaceId: string,
  fallback = 'agent',
): PaneLayout {
  return layouts[workspaceId] ?? singleColumn(fallback)
}

/**
 * Merge the snapshot's provisioning rows with optimistic ones, by
 * workspaceId (the snapshot wins), sorted by createdAt then id.
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
 * View state of a pane that unmounts when off-screen (the explorer), kept
 * here so it survives: expanded folders, scroll position, filter, and its
 * toggles. In memory only.
 */
export interface PaneView {
  expanded?: string[]
  scroll?: number
  find?: string
  showIgnored?: boolean
  /** List only the files changed since the diff base (the changes view). */
  changedOnly?: boolean
  /** In the changes view: one row per file with its full path, not a
   *  tree. Unset counts as flat, and opening the view sets it. */
  flat?: boolean
  /** In the changes view, whose folders start open: the ones closed. */
  collapsed?: string[]
  /** In the changes view, where each file's diff starts open under its row:
   *  the files whose diff is folded. Opening the view clears it. */
  foldedDiffs?: string[]
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
 * Per-project count of workspaces that need the user, for the rail's badge:
 * unread waiting ones, and asking ones whether viewed or not, since an ask
 * stays open until answered. Stopping workspaces (per the server or
 * `pendingDeleteIds`) don't count.
 */
export function unreadWaitingByProject(
  workspaces: Pick<WorkspaceListEntry, 'workspaceId' | 'projectId' | 'status' | 'waitingSinceMs' | 'stopping' | 'asking'>[],
  readWaiting: Record<string, number>,
  pendingDeleteIds: string[] = [],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of workspaces) {
    if (s.stopping || pendingDeleteIds.includes(s.workspaceId)) continue
    if (s.asking || isUnreadWaiting(s, readWaiting)) {
      out[s.projectId] = (out[s.projectId] ?? 0) + 1
    }
  }
  return out
}

/**
 * The workspace to select when the selection is left empty without the user
 * choosing it, or null to leave it empty. This covers two cases:
 *   1. the active project changed, and
 *   2. the selected workspace vanished (stopped from the CLI, reaped).
 * A selection the pane shows as a stopped workspace (`stopped`) has not
 * vanished. Both select the top row, except:
 *   - a create that claimed a prewarmed spare (`claims`) follows the spare's
 *     id once it is listed;
 *   - a selection whose provision is still in flight (`inFlight`) waits,
 *     since a snapshot can briefly miss both its row and its workspace.
 *
 * Null on a first load with nothing saved, and after a deselect.
 */
export function resolveVacantSelection(args: {
  /** The active project as of the previous render; null before there was one. */
  previousProjectId: string | null
  activeProjectId: string | null
  selectedWorkspaceId: string | null
  /** The sidebar's selectable rows in display order (`sidebarRowIds`). */
  rowIds: string[]
  /** The selection is a stopped workspace, or one still being looked up. */
  stopped?: boolean
  claims: Record<string, string>
  inFlight: string[]
}): string | null {
  const { previousProjectId, activeProjectId, selectedWorkspaceId, rowIds, claims, inFlight } = args
  if (!activeProjectId) return null
  if (selectedWorkspaceId && (rowIds.includes(selectedWorkspaceId) || args.stopped === true)) return null
  const vanished = selectedWorkspaceId !== null
  const switchedProject = previousProjectId !== null && previousProjectId !== activeProjectId
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
  projectId: string
  parent?: string
  editId?: string
  /** Reopen a saved draft (docs/draft-workspaces.md) on its fields. */
  draftId?: string
  /** Focus the prompt field. */
  focus?: 'prompt'
}

/**
 * A project add or remove this tab started, shown in the rail and in place
 * of the sidebar and pane while its request runs. It lasts until the
 * snapshot agrees (`settleProjectOps`), so the rail never flickers between
 * the request finishing and the snapshot listing the change.
 */
export interface ProjectOp {
  /** For a remove, the project's id. For an add, a client key, since the
   *  server assigns the id. Selectable as `activeProjectId`. */
  id: string
  kind: 'add' | 'remove'
  name: string
  remoteUrl: string
  /** The project's id, once the request has succeeded. */
  doneId?: string
  error?: string
}

/** The host key an SSH add trusted, kept for the user to compare against
 *  what the host publishes. */
export interface TrustedHostKey {
  projectName: string
  entry: string
}

/** Client-side UI state. Server state lives in the snapshot. */
interface UiState {
  /** The user whose projects the rail and sidebar show, picked in the user
   *  switcher or by opening a link into their project; null is the caller
   *  (see #lib/viewer). */
  viewedUserId: string | null
  /** Switch to another user's projects (null: the caller's), opening
   *  `projectId`, their first. */
  viewUser: (userId: string | null, projectId: string | null) => void
  /** Project whose workspaces the sidebar is scoped to (rail selection). */
  activeProjectId: string | null
  /** Workspace shown in the main pane. */
  selectedWorkspaceId: string | null
  /** Bumped when a workspace is selected or opened; the view then focuses
   *  its primary pane. */
  focusNonce: number
  /** Per-workspace counter; bumping one remounts and reattaches that
   *  workspace's terminals (e.g. after a restart). */
  terminalNonces: Record<string, number>
  /** Per-workspace pane layout. A missing key means the default single
   *  column (see `layoutOf`). */
  layouts: Record<string, PaneLayout>
  /** Per-workspace port the preview pane shows; missing means the first
   *  forwarded port. */
  previewPort: Record<string, number>
  /** Show another forwarded port in the preview pane. */
  setPreviewPort: (workspaceId: string, containerPort: number) => void
  /** Open or focus the preview pane, setting its port if unset. */
  openPreview: (workspaceId: string, containerPort?: number) => void
  /** Open or focus a workspace's file explorer in its changes view:
   *  changed files only, as a flat list, each with its diff, its filter
   *  focused. */
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
  /** How file panes show their changes. Saved. */
  fileDiffMode: FileDiffMode
  setFileDiffMode: (mode: FileDiffMode) => void
  /** Whether chat panes span the full pane width instead of a centered
   *  column. Saved; off by default. */
  chatFullWidth: boolean
  setChatFullWidth: (full: boolean) => void
  /** Whether chat panes fold away the steps between the user's prompts
   *  (`condense` in AcpTranscript). Saved; off by default. */
  chatCondensed: boolean
  setChatCondensed: (condensed: boolean) => void
  /** Tiles or tabs. Saved; small screens default to tabs. */
  viewMode: ViewMode
  /** Plan-usage metric pinned to the sidebar pill (a UsageBadge
   *  `metricKey`); null shows the tightest limit. Saved. */
  pinnedUsageMetric: string | null
  setPinnedUsageMetric: (key: string | null) => void
  /** Per-workspace active pane: the visible tab in tabs mode, the
   *  last-focused pane in tiles mode. Cycle shortcuts start from it. */
  activeTabs: Record<string, string>
  /** Per-workspace branch changes are diffed against; absent means the
   *  workspace's fork base. In memory only. */
  changesBase: Record<string, string>
  /** Set a workspace's diff base branch; undefined resets it. */
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
  /** Optimistic provisioning rows, shown until a snapshot lists the id
   *  (`reconcileSnapshot`). */
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
  /** The workspaces the last snapshot listed (`reconcileSnapshot`); null
   *  before the first. */
  liveWorkspaceIds: ReadonlySet<string> | null
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
  /** The add-project dialog's clone form when open, with the remote to
   *  prefill. Mounted once in App like the create dialog. */
  addProjectForm: { remoteUrl: string } | null
  setAddProjectForm: (form: { remoteUrl: string } | null) => void
  /** Host keys from finished SSH adds. The dialog shows them once no form is
   *  open, so a key never replaces a form being filled in. */
  trustedHostKeys: TrustedHostKey[]
  pushTrustedHostKey: (key: TrustedHostKey) => void
  clearTrustedHostKeys: () => void
  projectOps: ProjectOp[]
  /** Add an op, or replace the one with its id. */
  putProjectOp: (op: ProjectOp) => void
  patchProjectOp: (id: string, patch: Partial<ProjectOp>) => void
  dropProjectOp: (id: string) => void
  /** Drop the ops the snapshot's project list now reflects. A finished add
   *  being viewed hands the selection to the new project; a finished remove
   *  being viewed clears it. */
  settleProjectOps: (projectIds: string[]) => void
  /** A queued entry just created or moved from the create dialog, and its
   *  new parent. The sidebar expands its set once the snapshot shows it
   *  there, then clears this. */
  revealQueued: { id: string; parent: string } | null
  setRevealQueued: (reveal: { id: string; parent: string } | null) => void
  /** Whether the sidebar's Stopped section is expanded. Saved. */
  stoppedExpanded: boolean
  setStoppedExpanded: (expanded: boolean) => void
  /** Groups whose stopped members are shown as ghost rows ("Show stopped
   *  workspaces"). While such a group is on screen and expanded, its
   *  stopped members are left out of the Stopped section. */
  stoppedShownGroups: string[]
  setGroupShowsStopped: (groupId: string, shown: boolean) => void
  /** Groups the user collapsed; groups start expanded. */
  collapsedGroups: string[]
  setGroupCollapsed: (groupId: string, collapsed: boolean) => void
  /** The sidebar search box's text. Cleared when the project changes. */
  sidebarQuery: string
  setSidebarQuery: (query: string) => void
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
  /** Drop an optimistic row, e.g. on dismiss. */
  removeOptimisticProvisioning: (workspaceId: string) => void
  /**
   * Fold a snapshot from the server into the optimistic state: stop
   * tracking stops of workspaces it no longer lists, drop optimistic
   * provisioning rows it now has (as a workspace or its own row), and record
   * or forget prewarm claims (`claims`): a claim is forgotten when its create
   * failed or listed under its own id.
   */
  reconcileSnapshot: (snapshot: Pick<ServerSnapshot, 'workspaces' | 'provisioning'>) => void
  setActiveProject: (projectId: string | null) => void
  /** Like `setActiveProject`, for when App picks a project itself. Leaves
   *  the mobile screen alone (see MobileScreen). */
  restoreActiveProject: (projectId: string) => void
  /** The user picked a workspace; on mobile this moves to the pane screen. */
  selectWorkspace: (id: string | null) => void
  /** Like `selectWorkspace`, for when the app picks a workspace itself (see
   *  resolveVacantSelection, successorRow). Leaves the mobile screen alone. */
  autoSelectWorkspace: (id: string) => void
  /** Jump to a specific workspace, switching the active project to match. */
  openWorkspace: (projectId: string, workspaceId: string) => void
  reconnectTerminal: (workspaceId: string) => void
  /** Replace a workspace's layout (see #lib/layout). */
  setWorkspaceLayout: (workspaceId: string, layout: PaneLayout) => void
  toggleSidebar: () => void
  setViewMode: (mode: ViewMode) => void
  /** Record a workspace's active pane without moving focus, for focus the
   *  DOM already moved (a click into a pane). */
  setActiveTab: (workspaceId: string, target: string) => void
  /** Make a pane active and focus it, for tab clicks and shortcuts. */
  focusTerminal: (workspaceId: string, target: string) => void
  /** Mark a workspace as stopping, optimistically. A workspace the last
   *  snapshot no longer lists (it died while the stop was being confirmed)
   *  is not marked, since no later snapshot would clear it. */
  beginDelete: (workspaceId: string) => void
  /** Clear the stopping mark, when the stop fails. */
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
  const added = addColumn(layoutOf(s.layouts, workspaceId), target)
  return {
    layouts: { ...s.layouts, [workspaceId]: withActive(added, target) },
    activeTabs: { ...s.activeTabs, [workspaceId]: target },
    focusNonce: s.focusNonce + 1,
  }
}

const initialSelection = loadSelection()

/** `list` with `id` added (`on`) or removed, unchanged if already so. */
function toggled(list: string[], id: string, on: boolean): string[] {
  if (list.includes(id) === on) return list
  return on ? [...list, id] : list.filter((x) => x !== id)
}

/**
 * Whether shortcuts are off: while settings records a rebind, or while the
 * create dialog is open (where they could discard the prompt or queue a
 * stop, and on macOS Option chords type characters such as ñ).
 */
export function shortcutsSuspended(state: Pick<UiState, 'recordingShortcut' | 'createWorkspaceDialog'>): boolean {
  return state.recordingShortcut || state.createWorkspaceDialog !== null
}

export const useUiStore = create<UiState>((set) => ({
  viewedUserId: null,
  viewUser: (userId, projectId) => set({
    viewedUserId: userId, activeProjectId: projectId, selectedWorkspaceId: null, sidebarQuery: '',
  }),
  activeProjectId: initialSelection.projectId,
  selectedWorkspaceId: initialSelection.workspaceId,
  focusNonce: 0,
  terminalNonces: {},
  layouts: {},
  previewPort: {},
  sidebarOpen: true,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  mobileScreen: defaultMobileScreen(),
  setMobileScreen: (screen) => set((s) => (s.mobileScreen === screen ? s : { mobileScreen: screen })),
  themePref: 'system',
  soundEnabled: true,
  editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
  fileDiffMode: 'plain',
  chatFullWidth: false,
  chatCondensed: true,
  viewMode: defaultViewMode(),
  pinnedUsageMetric: null,
  chatDrafts: {},
  readWaiting: {},
  ...loadPersisted(),
  activeTabs: {},
  changesBase: {},
  paneView: {},
  filesFindPending: false,
  dirtyFiles: {},
  optimisticProvisioning: [],
  pendingDeleteIds: [],
  liveWorkspaceIds: null,
  optimisticStopped: [],
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
  addProjectForm: null,
  setAddProjectForm: (addProjectForm) => set({ addProjectForm }),
  trustedHostKeys: [],
  pushTrustedHostKey: (key) => set((s) => ({ trustedHostKeys: [...s.trustedHostKeys, key] })),
  clearTrustedHostKeys: () => set({ trustedHostKeys: [] }),
  projectOps: [],
  putProjectOp: (op) => set((s) => ({ projectOps: [...s.projectOps.filter((o) => o.id !== op.id), op] })),
  patchProjectOp: (id, patch) => set((s) => ({
    projectOps: s.projectOps.map((o) => (o.id === id ? { ...o, ...patch } : o)),
  })),
  dropProjectOp: (id) => set((s) => ({ projectOps: s.projectOps.filter((o) => o.id !== id) })),
  settleProjectOps: (projectIds) => set((s) => {
    const settled = s.projectOps.filter((o) => o.doneId !== undefined
      && projectIds.includes(o.doneId) === (o.kind === 'add'))
    if (settled.length === 0) return s
    const viewed = settled.find((o) => o.id === s.activeProjectId)
    return {
      projectOps: s.projectOps.filter((o) => !settled.includes(o)),
      ...(viewed?.kind === 'add' && { activeProjectId: viewed.doneId, selectedWorkspaceId: null }),
      ...(viewed?.kind === 'remove' && { activeProjectId: null, selectedWorkspaceId: null, mobileScreen: 'projects' }),
    }
  }),
  revealQueued: null,
  setRevealQueued: (reveal) => set({ revealQueued: reveal }),
  stoppedExpanded: false,
  setStoppedExpanded: (stoppedExpanded) => set({ stoppedExpanded }),
  stoppedShownGroups: [],
  setGroupShowsStopped: (groupId, shown) => set((s) => ({
    stoppedShownGroups: toggled(s.stoppedShownGroups, groupId, shown),
  })),
  collapsedGroups: [],
  setGroupCollapsed: (groupId, collapsed) => set((s) => ({
    collapsedGroups: toggled(s.collapsedGroups, groupId, collapsed),
  })),
  sidebarQuery: '',
  setSidebarQuery: (sidebarQuery) => set({ sidebarQuery }),

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
  reconcileSnapshot: (snapshot) => set((s) => {
    const live = new Set(snapshot.workspaces.map((w) => w.workspaceId))
    const known = new Set([...live, ...snapshot.provisioning.map((p) => p.workspaceId)])
    const claims = { ...s.claims }
    for (const p of snapshot.provisioning) {
      if (p.error !== undefined) delete claims[p.workspaceId]
      else if (p.claimedId) claims[p.workspaceId] = p.claimedId
    }
    for (const id of live) delete claims[id]
    const pendingDeleteIds = s.pendingDeleteIds.filter((id) => live.has(id))
    const optimisticProvisioning = s.optimisticProvisioning.filter((e) => !known.has(e.workspaceId))
    const sameClaims = Object.keys(claims).length === Object.keys(s.claims).length
      && Object.entries(claims).every(([k, v]) => s.claims[k] === v)
    const sameLive = s.liveWorkspaceIds !== null && s.liveWorkspaceIds.size === live.size
      && [...live].every((id) => s.liveWorkspaceIds?.has(id))
    const patch = {
      ...(sameLive ? {} : { liveWorkspaceIds: live }),
      ...(sameClaims ? {} : { claims }),
      ...(pendingDeleteIds.length === s.pendingDeleteIds.length ? {} : { pendingDeleteIds }),
      ...(optimisticProvisioning.length === s.optimisticProvisioning.length ? {} : { optimisticProvisioning }),
    }
    return Object.keys(patch).length === 0 ? s : patch
  }),
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
  setActiveProject: (projectId) => set({
    activeProjectId: projectId,
    selectedWorkspaceId: null,
    sidebarQuery: '',
    mobileScreen: projectId ? 'workspaces' : 'projects',
  }),
  restoreActiveProject: (projectId) => set({ activeProjectId: projectId, selectedWorkspaceId: null, sidebarQuery: '' }),
  // A deselect (null) doesn't change the mobile screen.
  selectWorkspace: (id) => set((s) => ({
    selectedWorkspaceId: id,
    focusNonce: s.focusNonce + 1,
    mobileScreen: id ? 'pane' : s.mobileScreen,
  })),
  autoSelectWorkspace: (id) => set((s) => ({ selectedWorkspaceId: id, focusNonce: s.focusNonce + 1 })),
  openWorkspace: (projectId, workspaceId) => set((s) => ({
    activeProjectId: projectId,
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
  openPreview: (workspaceId, containerPort) => set((s) => ({
    ...openSpecialPane(s, workspaceId, PREVIEW_TARGET),
    ...(containerPort !== undefined && s.previewPort[workspaceId] === undefined
      ? { previewPort: { ...s.previewPort, [workspaceId]: containerPort } }
      : {}),
  })),
  openChanges: (workspaceId) => set((s) => {
    const key = paneViewKey(workspaceId, FILES_TARGET)
    return {
      ...openSpecialPane(s, workspaceId, FILES_TARGET),
      paneView: { ...s.paneView, [key]: { ...s.paneView[key], changedOnly: true, flat: true, foldedDiffs: [], find: '' } },
      // Focus its filter, as the open-files shortcut does, so Cmd/Ctrl-F
      // and typing work without a click.
      filesFindPending: true,
    }
  }),
  openFiles: (workspaceId) => set((s) => openSpecialPane(s, workspaceId, FILES_TARGET)),
  openFile: (workspaceId, path) => set((s) => {
    const target = fileTarget(path)
    const placed = placeFile(layoutOf(s.layouts, workspaceId), target, s.activeTabs[workspaceId])
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
    applyThemeAttribute(pref)
    set({ themePref: pref })
  },
  setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
  setChatFullWidth: (full) => set({ chatFullWidth: full }),
  setChatCondensed: (condensed) => set({ chatCondensed: condensed }),
  setEditorFontSize: (px) => set({ editorFontSize: clampEditorFontSize(px) }),
  setFileDiffMode: (mode) => set({ fileDiffMode: mode }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setPinnedUsageMetric: (key) => set({ pinnedUsageMetric: key }),
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
    const cur = layoutOf(s.layouts, workspaceId)
    const layout = renameTargets(cur, fileTarget(from), fileTarget(to))
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
      ...(layout !== cur ? { layouts: { ...s.layouts, [workspaceId]: layout } } : {}),
    }
  }),
  closeFiles: (workspaceId, paths) => set((s) => {
    const cur = layoutOf(s.layouts, workspaceId)
    let layout = cur
    for (const p of paths) layout = removeTarget(layout, fileTarget(p))
    const dirtyFiles = { ...s.dirtyFiles }
    for (const p of paths) delete dirtyFiles[fileKey(workspaceId, p)]
    return {
      dirtyFiles,
      ...(layout !== cur ? { layouts: { ...s.layouts, [workspaceId]: layout } } : {}),
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
    const cur = layoutOf(s.layouts, workspaceId)
    const next = withActive(cur, target)
    return {
      ...(next === cur ? {} : { layouts: { ...s.layouts, [workspaceId]: next } }),
      activeTabs: { ...s.activeTabs, [workspaceId]: target },
      focusNonce: s.focusNonce + 1,
    }
  }),
  beginDelete: (workspaceId) => set((s) => (
    s.pendingDeleteIds.includes(workspaceId) || s.liveWorkspaceIds?.has(workspaceId) === false
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

// Save each persisted field as it changes, and mirror the selection into
// the URL so a link is shareable. Chat drafts change on every keystroke, so
// they are saved on a trailing timer instead.
useUiStore.subscribe((state, prev) => {
  for (const field of persistedFields) {
    if (field !== 'chatDrafts' && state[field] !== prev[field]) savePersisted(field, state[field])
  }
  if (
    state.activeProjectId !== prev.activeProjectId
    || state.selectedWorkspaceId !== prev.selectedWorkspaceId
  ) {
    persistSelection(state.activeProjectId, state.selectedWorkspaceId)
  }
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
  savePersisted('chatDrafts', unwrittenDrafts)
  unwrittenDrafts = null
}

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
