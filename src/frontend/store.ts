import { create } from 'zustand'
import { isLayoutNode, type LayoutNode } from '@/frontend/lib/layout'
import type { DeletedSessionEntry, ProvisioningSessionEntry } from '@/shared/types'

const LAYOUTS_LS_KEY = 'yaac.layouts.v1'
const VIEWMODE_LS_KEY = 'yaac.viewmode.v1'
const SELECTION_LS_KEY = 'yaac.selection.v1'

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
 * params like `bootstrap` are preserved). The SPA is served only at `/`, so
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
 * Merge daemon-snapshot provisioning rows with local optimistic ones, deduped
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

/** Local-only UI state (not daemon state — that lives in the snapshot). */
interface UiState {
  /** Project whose sessions the sidebar is scoped to (rail selection). */
  activeProjectSlug: string | null
  /** Session shown in the main pane. */
  selectedSessionId: string | null
  /** Bumped every time a session is selected or opened. The view watches it
   *  to pull keyboard focus into that session's primary pane — a plain
   *  textarea focus, never a synthetic click (which xterm would forward to
   *  tmux as a mouse event). */
  focusNonce: number
  /** Per-session counter; bumping one forces that terminal to remount +
   *  reattach (e.g. after a restart) without disturbing the others. */
  terminalNonces: Record<string, number>
  /** Per-session workspace layout tree. Missing key = the default single
   *  agent pane; null = an explicitly emptied workspace. */
  layouts: Record<string, LayoutNode | null>
  /** Whether the session sidebar is shown. */
  sidebarOpen: boolean
  /** Tiling WM vs one-at-a-time tabs (persisted; small screens default
   *  to tabs). The layout tree stays canonical in both modes. */
  viewMode: ViewMode
  /** Per-session active terminal in tabs mode. */
  activeTabs: Record<string, string>
  /** Locally-initiated provisioning rows, shown the instant create/restart is
   *  clicked. The daemon snapshot's `provisioning[]` is the source of truth;
   *  these only bridge the gap until the first snapshot frame carries the id,
   *  then they're pruned. */
  optimisticProvisioning: ProvisioningSessionEntry[]
  /** Sessions whose delete was confirmed — hidden optimistically until the
   *  daemon's (detached) cleanup completes and the snapshot drops them. */
  pendingDeleteIds: string[]
  /** Just-deleted sessions (that had history) shown optimistically in the
   *  Deleted group until the daemon's list-deleted catches up. */
  optimisticDeleted: DeletedSessionEntry[]
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
  setActiveTab: (sessionId: string, target: string) => void
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
}

const initialSelection = loadSelection()

export const useUiStore = create<UiState>((set) => ({
  activeProjectSlug: initialSelection.projectSlug,
  selectedSessionId: initialSelection.sessionId,
  focusNonce: 0,
  terminalNonces: {},
  layouts: loadPersistedLayouts(),
  sidebarOpen: true,
  viewMode: loadViewMode(),
  activeTabs: {},
  optimisticProvisioning: [],
  pendingDeleteIds: [],
  optimisticDeleted: [],
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
  setViewMode: (mode) => {
    persistViewMode(mode)
    set({ viewMode: mode })
  },
  setActiveTab: (sessionId, target) => set((s) => ({
    activeTabs: { ...s.activeTabs, [sessionId]: target },
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
