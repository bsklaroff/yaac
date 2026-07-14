import { create } from 'zustand'
import { isLayoutNode, type LayoutNode } from '#lib/layout'
import { DEFAULT_BINDINGS, type BindingMap, type Chord, type ShortcutId } from '#lib/shortcuts'
import { applyThemeAttribute, loadThemePref, persistThemePref, type ThemePref } from '#lib/theme'
import type { AgentTool, DeletedSessionEntry, ProvisioningSessionEntry, SessionListEntry } from '@yaac/shared/types'

const LAYOUTS_LS_KEY = 'yaac.layouts.v1'
const VIEWMODE_LS_KEY = 'yaac.viewmode.v1'
const SELECTION_LS_KEY = 'yaac.selection.v1'
const READ_WAITING_LS_KEY = 'yaac.readwaiting.v1'
const PINNED_USAGE_LS_KEY = 'yaac.pinnedusage.v1'
const SOUND_LS_KEY = 'yaac.sound.v1'

/** Whether the attention chime plays; defaults on (exported for tests). */
export function loadSoundEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(SOUND_LS_KEY) !== '0'
  } catch { /* fall through to the default */ }
  return true
}

/** Persist the sound preference; best-effort (exported for tests). */
export function persistSoundEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_LS_KEY, enabled ? '1' : '0')
  } catch { /* non-fatal */ }
}

/** How the workspace renders its terminals: a tiling window manager, or
 *  one-at-a-time tabs (better on small screens). */
export type ViewMode = 'tiles' | 'tabs'

/** Persisted view mode; first-run default keys off the viewport width
 *  (exported for tests). */
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

/** The project + session the workspace is currently viewing — persisted so a
 *  reload, or a shared/bookmarked link, reopens the same view. */
export interface PersistedSelection {
  projectSlug: string | null
  sessionId: string | null
}

/**
 * Read the persisted selection. The URL query wins over localStorage — a
 * shared `?project=…&session=…` link should override the last local view —
 * with localStorage as the fallback for a bare reload. The session is only a
 * hint: App drops it if that session is no longer active. Exported for tests.
 */
export function loadSelection(): PersistedSelection {
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const projectSlug = params.get('project')
      if (projectSlug) return { projectSlug, sessionId: params.get('session') }
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
            sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
          }
        }
      }
    }
  } catch { /* fall through to the empty default */ }
  return { projectSlug: null, sessionId: null }
}

/**
 * Persist the selection to localStorage and mirror it into the URL bar as
 * `?project=&session=` query params (replaceState — no navigation; unrelated
 * params like `token` are preserved). The SPA is served only at `/`, so
 * query params (not a path) keep deep links working on a hard reload.
 * Best-effort. Exported for tests.
 */
export function persistSelection(projectSlug: string | null, sessionId: string | null): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SELECTION_LS_KEY, JSON.stringify({ projectSlug, sessionId }))
    }
  } catch { /* quota/serialization failures are non-fatal */ }
  try {
    if (typeof window !== 'undefined' && window.history) {
      const url = new URL(window.location.href)
      if (projectSlug) url.searchParams.set('project', projectSlug)
      else url.searchParams.delete('project')
      if (sessionId) url.searchParams.set('session', sessionId)
      else url.searchParams.delete('session')
      window.history.replaceState({}, '', url.pathname + url.search + url.hash)
    }
  } catch { /* history failures are non-fatal */ }
}

/** Read the persisted pinned plan-usage metric key (a UsageBadge
 *  `metricKey`), null when nothing is pinned (exported for tests). */
export function loadPinnedUsageMetric(): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PINNED_USAGE_LS_KEY)
      if (raw) return raw
    }
  } catch { /* fall through to the default */ }
  return null
}

/** Persist the pinned plan-usage metric key (null clears the pin);
 *  best-effort (exported for tests). */
export function persistPinnedUsageMetric(key: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (key) localStorage.setItem(PINNED_USAGE_LS_KEY, key)
    else localStorage.removeItem(PINNED_USAGE_LS_KEY)
  } catch { /* non-fatal — the pin just won't stick */ }
}

/** Read persisted workspace layouts, dropping anything structurally
 *  invalid (exported for tests). */
export function loadPersistedLayouts(): Record<string, LayoutNode | null> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(LAYOUTS_LS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, LayoutNode | null> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || isLayoutNode(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Read persisted read-waiting marks (sessionId → waitingSinceMs of the spell
 *  that was viewed), dropping anything that isn't a number (exported for
 *  tests). Stale marks are pruned against the first snapshot by
 *  syncWaitingRead. */
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

/** Persist read-waiting marks; best-effort (exported for tests). */
export function persistReadWaiting(marks: Record<string, number>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(READ_WAITING_LS_KEY, JSON.stringify(marks))
  } catch {
    // quota/serialization failures are non-fatal — marks just won't stick
  }
}

/** Persist workspace layouts; best-effort (exported for tests). */
export function persistLayouts(layouts: Record<string, LayoutNode | null>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LAYOUTS_LS_KEY, JSON.stringify(layouts))
  } catch {
    // quota/serialization failures are non-fatal — layouts just won't stick
  }
}

/**
 * Merge server-snapshot provisioning rows with local optimistic ones, deduped
 * by sessionId (the snapshot wins — it carries the live message/error), sorted
 * by createdAt then id for a stable sidebar order. The optimistic copy only
 * fills the gap between clicking create and the first snapshot frame; once the
 * snapshot knows the id, App prunes it.
 */
export function mergeProvisioning(
  snapshot: ProvisioningSessionEntry[],
  optimistic: ProvisioningSessionEntry[],
): ProvisioningSessionEntry[] {
  const byId = new Map<string, ProvisioningSessionEntry>()
  for (const e of optimistic) byId.set(e.sessionId, e)
  for (const e of snapshot) byId.set(e.sessionId, e)
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId),
  )
}

/** A terminal pane identity — a /pty/attach target:
 *  'agent', 'shell:<name>', or 'window:@<id>'. */
export type TerminalTab = string

/**
 * Whether a session is waiting and its current waiting spell hasn't been
 * viewed. A read mark stores the spell's waitingSinceMs, so a mark from an
 * earlier spell (session ran and is waiting again — even across a page
 * reload) no longer matches and the session re-flags. A missing
 * waitingSinceMs (server predating the field) is normalized to 0.
 */
export function isUnreadWaiting(
  session: Pick<SessionListEntry, 'sessionId' | 'status' | 'waitingSinceMs'>,
  readWaiting: Record<string, number>,
): boolean {
  return session.status === 'waiting' && readWaiting[session.sessionId] !== (session.waitingSinceMs ?? 0)
}

/**
 * Per-project count of unread waiting sessions — waiting and not yet viewed
 * during the current waiting spell. Drives the rail attention badge, so a
 * waiting session the user has already looked at doesn't keep flagging.
 * Terminating sessions never count: the server marks them `terminating` (and
 * forces their status off 'waiting'), and a UI-initiated delete not yet
 * reflected in the snapshot is covered by `pendingDeleteIds` — either way a
 * session on its way out must not flash the badge.
 */
export function unreadWaitingBySlug(
  sessions: Pick<SessionListEntry, 'sessionId' | 'projectSlug' | 'status' | 'waitingSinceMs' | 'terminating'>[],
  readWaiting: Record<string, number>,
  pendingDeleteIds: string[] = [],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sessions) {
    if (s.terminating || pendingDeleteIds.includes(s.sessionId)) continue
    if (isUnreadWaiting(s, readWaiting)) {
      out[s.projectSlug] = (out[s.projectSlug] ?? 0) + 1
    }
  }
  return out
}

/**
 * The session Alt+B lands on: the one most in need of attention. Callers pass
 * the sidebar's sessions (mid-delete rows already filtered out); status order
 * within the array matches the display order, since the Waiting group renders
 * above Running and each group preserves array order. Priority:
 *   1. the topmost session with an unread waiting notification,
 *   2. else the topmost waiting session (already viewed this spell),
 *   3. else the topmost running session.
 * Null when there's nothing to jump to.
 */
export function resolveAttentionTarget(
  sessions: Pick<SessionListEntry, 'sessionId' | 'status' | 'waitingSinceMs'>[],
  readWaiting: Record<string, number>,
): string | null {
  const unread = sessions.find((s) => isUnreadWaiting(s, readWaiting))
  if (unread) return unread.sessionId
  const waiting = sessions.find((s) => s.status === 'waiting')
  if (waiting) return waiting.sessionId
  return sessions.find((s) => s.status === 'running')?.sessionId ?? null
}

/**
 * The tool the new-session shortcut would launch — the selected session's
 * tool, else claude — gated on its credentials being configured. Null means
 * the shortcut must be ignored: the target tool has no stored credential
 * (which includes the moment before the auth list has loaded).
 */
export function resolveNewSessionTool(
  sessions: Pick<SessionListEntry, 'sessionId' | 'tool'>[],
  selectedSessionId: string | null,
  configured: ReadonlySet<AgentTool>,
): AgentTool | null {
  const tool = sessions.find((s) => s.sessionId === selectedSessionId)?.tool ?? 'claude'
  return configured.has(tool) ? tool : null
}

/** Sections of the settings modal (left-nav entries). */
export type SettingsSection = 'general' | 'shortcuts' | 'credentials' | 'project' | 'userDockerfile'

/** Local-only UI state (not server state — that lives in the snapshot). */
interface UiState {
  /** Project whose sessions the sidebar is scoped to (rail selection). */
  activeProjectSlug: string | null
  /** Session shown in the main pane. */
  selectedSessionId: string | null
  /** Bumped every time a session is selected or opened. The view watches it
   *  to pull keyboard focus into that session's primary pane — a plain
   *  textarea focus, never a synthetic click (which would clobber any
   *  local selection in the terminal). */
  focusNonce: number
  /** Per-session counter; bumping one forces that terminal to remount +
   *  reattach (e.g. after a restart) without disturbing the others. */
  terminalNonces: Record<string, number>
  /** Per-session workspace layout tree. Missing key = the default single
   *  agent pane; null = an explicitly emptied workspace. */
  layouts: Record<string, LayoutNode | null>
  /** Whether the session sidebar is shown. */
  sidebarOpen: boolean
  /** Light/dark preference. 'system' follows the OS; setThemePref persists it
   *  and reflects it onto <html data-theme> for the CSS palette (index.css). */
  themePref: ThemePref
  setThemePref: (pref: ThemePref) => void
  /** Whether the attention chime plays when a session flips to waiting. */
  soundEnabled: boolean
  setSoundEnabled: (enabled: boolean) => void
  /** Tiling WM vs one-at-a-time tabs (persisted; small screens default
   *  to tabs). The layout tree stays canonical in both modes. */
  viewMode: ViewMode
  /** Plan-usage metric pinned to the sidebar pill (a UsageBadge
   *  `metricKey`); null shows the tightest limit. Persisted. */
  pinnedUsageMetric: string | null
  setPinnedUsageMetric: (key: string | null) => void
  /** Per-session active terminal: the visible tab in tabs mode, the
   *  last-focused pane in tiles mode. Tab-switch shortcuts cycle from it. */
  activeTabs: Record<string, string>
  /** Locally-initiated provisioning rows, shown the instant create/restart is
   *  clicked. The server snapshot's `provisioning[]` is the source of truth;
   *  these only bridge the gap until the first snapshot frame carries the id,
   *  then they're pruned. */
  optimisticProvisioning: ProvisioningSessionEntry[]
  /** Sessions whose delete was confirmed — rendered as "terminating…"
   *  optimistically (bridging the gap before the snapshot carries the
   *  server's own `terminating` flag) until the snapshot drops them. */
  pendingDeleteIds: string[]
  /** Just-deleted sessions (that had history) shown optimistically in the
   *  deleted-sessions view until the server's list-deleted catches up. */
  optimisticDeleted: DeletedSessionEntry[]
  /** Read marks for waiting sessions: sessionId → waitingSinceMs of the
   *  spell the user viewed. Keying by spell means a mark from an earlier
   *  wait never hides a new one, even across reloads or a page that was
   *  closed through the whole round trip. Persisted; syncWaitingRead GCs
   *  marks whose spell is over. */
  readWaiting: Record<string, number>
  /** Keyboard-shortcut bindings (command id → chord). Starts at the factory
   *  defaults and is replaced once the server's saved overrides load at
   *  startup; the window keydown listeners read this at event time. */
  bindings: BindingMap
  /** Replace the whole binding map — used to hydrate the saved overrides. */
  setBindings: (bindings: BindingMap) => void
  /** Rebind a single command. */
  setBinding: (id: ShortcutId, chord: Chord) => void
  /** Restore every command to its factory default. */
  resetBindings: () => void
  /** True while the settings pane is capturing a chord for a rebind. The
   *  workspace keydown listeners bail on it, so the recorded chord doesn't also
   *  fire the command it's being bound to. */
  recordingShortcut: boolean
  setRecordingShortcut: (recording: boolean) => void
  /** Whether the settings modal is open. Lives here (not in the gear button)
   *  so other surfaces — e.g. a "Sign in" item in the new-session menu — can
   *  open settings onto a specific section. */
  settingsOpen: boolean
  /** Section the settings modal shows; sticky across open/close. */
  settingsSection: SettingsSection
  /** Tool whose sign-in form the credentials section auto-expands — set when
   *  settings was opened via a "Sign in" affordance; cleared on close. */
  settingsFocusTool: AgentTool | null
  /** Open settings — optionally onto a section, with a tool's sign-in form
   *  expanded. Without args it reopens on the last-viewed section. */
  openSettings: (section?: SettingsSection, focusTool?: AgentTool) => void
  closeSettings: () => void
  setSettingsSection: (section: SettingsSection) => void
  /** Whether the full-screen deleted-sessions view is open. Opened from the
   *  sidebar header; scoped to the active project when rendered. */
  deletedOverlayOpen: boolean
  openDeletedOverlay: () => void
  closeDeletedOverlay: () => void
  /** Add a locally-initiated provisioning row (dedup by id). */
  addOptimisticProvisioning: (entry: ProvisioningSessionEntry) => void
  /** Patch a tracked optimistic row's message or error (no-op if absent). */
  updateOptimisticProvisioning: (sessionId: string, patch: { message?: string; error?: string }) => void
  /** Drop an optimistic row — once the snapshot knows the id, or on dismiss. */
  removeOptimisticProvisioning: (sessionId: string) => void
  setActiveProject: (slug: string | null) => void
  selectSession: (id: string | null) => void
  /** Jump to a specific session, switching the active project to match. */
  openSession: (projectSlug: string, sessionId: string) => void
  reconnectTerminal: (sessionId: string) => void
  /** Replace a session's workspace layout (trees are built with the pure
   *  helpers in lib/layout). */
  setSessionLayout: (sessionId: string, layout: LayoutNode | null) => void
  toggleSidebar: () => void
  setViewMode: (mode: ViewMode) => void
  /** Record a session's active terminal without moving keyboard focus —
   *  for focus changes the DOM already made (clicking into a pane). */
  setActiveTab: (sessionId: string, target: string) => void
  /** Make a terminal active AND pull keyboard focus into it — for tab
   *  clicks and the tab-switch shortcuts. */
  focusTerminal: (sessionId: string, target: string) => void
  /** Optimistically hide a session being deleted. */
  beginDelete: (sessionId: string) => void
  /** Stop hiding a session — on delete error (restore) or once the snapshot
   *  confirms it's gone (prune). */
  endDelete: (sessionId: string) => void
  /** Optimistically show a just-deleted session in the Deleted group. */
  addOptimisticDeleted: (entry: DeletedSessionEntry) => void
  /** Drop an optimistic deleted entry — once list-deleted includes it, or on
   *  restart. */
  removeOptimisticDeleted: (sessionId: string) => void
  /** Mark a session's current waiting spell as seen (it's open in the main
   *  pane). Pass the entry's waitingSinceMs (normalized: missing → 0). */
  markWaitingRead: (sessionId: string, waitingSinceMs: number) => void
  /** GC read marks against the currently-waiting (sessionId, waitingSinceMs)
   *  pairs: a mark whose spell is over (session running, gone, or waiting
   *  anew) no longer matches anything and is dropped. Correctness doesn't
   *  depend on this — isUnreadWaiting compares spells — it only keeps the
   *  persisted map from growing. */
  syncWaitingRead: (waiting: { sessionId: string; waitingSinceMs: number }[]) => void
}

const initialSelection = loadSelection()

export const useUiStore = create<UiState>((set) => ({
  activeProjectSlug: initialSelection.projectSlug,
  selectedSessionId: initialSelection.sessionId,
  focusNonce: 0,
  terminalNonces: {},
  layouts: loadPersistedLayouts(),
  sidebarOpen: true,
  themePref: loadThemePref(),
  soundEnabled: loadSoundEnabled(),
  viewMode: loadViewMode(),
  pinnedUsageMetric: loadPinnedUsageMetric(),
  activeTabs: {},
  optimisticProvisioning: [],
  pendingDeleteIds: [],
  optimisticDeleted: [],
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
  openSettings: (section, focusTool) => set((s) => ({
    settingsOpen: true,
    settingsSection: section ?? s.settingsSection,
    settingsFocusTool: focusTool ?? null,
  })),
  closeSettings: () => set({ settingsOpen: false, settingsFocusTool: null }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  deletedOverlayOpen: false,
  openDeletedOverlay: () => set({ deletedOverlayOpen: true }),
  closeDeletedOverlay: () => set({ deletedOverlayOpen: false }),
  addOptimisticProvisioning: (entry) => set((s) => (
    s.optimisticProvisioning.some((e) => e.sessionId === entry.sessionId)
      ? s
      : { optimisticProvisioning: [...s.optimisticProvisioning, entry] }
  )),
  updateOptimisticProvisioning: (sessionId, patch) => set((s) => (
    s.optimisticProvisioning.some((e) => e.sessionId === sessionId)
      ? {
          optimisticProvisioning: s.optimisticProvisioning.map((e) =>
            e.sessionId === sessionId ? { ...e, ...patch } : e),
        }
      : s
  )),
  removeOptimisticProvisioning: (sessionId) => set((s) => (
    s.optimisticProvisioning.some((e) => e.sessionId === sessionId)
      ? { optimisticProvisioning: s.optimisticProvisioning.filter((e) => e.sessionId !== sessionId) }
      : s
  )),
  // Switching projects clears the open session — the sidebar now shows a
  // different project's sessions, so the old selection no longer belongs.
  setActiveProject: (slug) => set({ activeProjectSlug: slug, selectedSessionId: null }),
  selectSession: (id) => set((s) => ({ selectedSessionId: id, focusNonce: s.focusNonce + 1 })),
  openSession: (projectSlug, sessionId) =>
    set((s) => ({ activeProjectSlug: projectSlug, selectedSessionId: sessionId, focusNonce: s.focusNonce + 1 })),
  reconnectTerminal: (sessionId) => set((s) => ({
    terminalNonces: { ...s.terminalNonces, [sessionId]: (s.terminalNonces[sessionId] ?? 0) + 1 },
  })),
  setSessionLayout: (sessionId, layout) => set((s) => ({
    layouts: { ...s.layouts, [sessionId]: layout },
  })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setThemePref: (pref) => {
    persistThemePref(pref)
    applyThemeAttribute(pref)
    set({ themePref: pref })
  },
  setSoundEnabled: (enabled) => {
    persistSoundEnabled(enabled)
    set({ soundEnabled: enabled })
  },
  setViewMode: (mode) => {
    persistViewMode(mode)
    set({ viewMode: mode })
  },
  setPinnedUsageMetric: (key) => {
    persistPinnedUsageMetric(key)
    set({ pinnedUsageMetric: key })
  },
  setActiveTab: (sessionId, target) => set((s) => (
    s.activeTabs[sessionId] === target
      ? s
      : { activeTabs: { ...s.activeTabs, [sessionId]: target } }
  )),
  focusTerminal: (sessionId, target) => set((s) => ({
    activeTabs: { ...s.activeTabs, [sessionId]: target },
    focusNonce: s.focusNonce + 1,
  })),
  beginDelete: (sessionId) => set((s) => (
    s.pendingDeleteIds.includes(sessionId)
      ? s
      : { pendingDeleteIds: [...s.pendingDeleteIds, sessionId] }
  )),
  endDelete: (sessionId) => set((s) => (
    s.pendingDeleteIds.includes(sessionId)
      ? { pendingDeleteIds: s.pendingDeleteIds.filter((id) => id !== sessionId) }
      : s
  )),
  addOptimisticDeleted: (entry) => set((s) => (
    s.optimisticDeleted.some((e) => e.sessionId === entry.sessionId)
      ? s
      : { optimisticDeleted: [entry, ...s.optimisticDeleted] }
  )),
  removeOptimisticDeleted: (sessionId) => set((s) => (
    s.optimisticDeleted.some((e) => e.sessionId === sessionId)
      ? { optimisticDeleted: s.optimisticDeleted.filter((e) => e.sessionId !== sessionId) }
      : s
  )),
  markWaitingRead: (sessionId, waitingSinceMs) => set((s) => (
    s.readWaiting[sessionId] === waitingSinceMs
      ? s
      : { readWaiting: { ...s.readWaiting, [sessionId]: waitingSinceMs } }
  )),
  syncWaitingRead: (waiting) => set((s) => {
    const current = new Map(waiting.map((w) => [w.sessionId, w.waitingSinceMs]))
    const kept: Record<string, number> = {}
    for (const [id, since] of Object.entries(s.readWaiting)) {
      if (current.get(id) === since) kept[id] = since
    }
    return Object.keys(kept).length === Object.keys(s.readWaiting).length ? s : { readWaiting: kept }
  }),
}))

// Workspace layouts survive reloads. Session ids are stable across restarts
// (restart resumes the same id), so a restored session gets its old layout
// back too.
useUiStore.subscribe((state, prev) => {
  if (state.layouts !== prev.layouts) persistLayouts(state.layouts)
})

// The active project + session survive reloads and are mirrored into the URL
// bar so a link is shareable. Only the session is liveness-gated — App drops a
// restored selection whose session is no longer active.
useUiStore.subscribe((state, prev) => {
  if (
    state.activeProjectSlug !== prev.activeProjectSlug
    || state.selectedSessionId !== prev.selectedSessionId
  ) {
    persistSelection(state.activeProjectSlug, state.selectedSessionId)
  }
})

// Read marks survive reloads so already-viewed waiting sessions don't
// re-flag. Marks are keyed by the server's waitingSinceMs, so a session
// that waited anew while the page was closed carries a different spell
// timestamp and correctly shows unread; restored stale marks are GC'd
// against the first snapshot.
useUiStore.subscribe((state, prev) => {
  if (state.readWaiting !== prev.readWaiting) persistReadWaiting(state.readWaiting)
})
