import { create } from 'zustand'
import { isLayoutNode, type LayoutNode } from '@/frontend/lib/layout'
import type { AgentTool, DeletedSessionEntry } from '@/shared/types'

const LAYOUTS_LS_KEY = 'yaac.layouts.v1'
const VIEWMODE_LS_KEY = 'yaac.viewmode.v1'

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

/** A session being provisioned — shown as an immediate sidebar row (in a
 *  "starting" state) and a main-pane placeholder. Persists from the moment
 *  create is clicked until the real session lands in the snapshot. */
export interface CreatingSession {
  projectSlug: string
  tool: AgentTool
  message: string
  /** Set once provisioning resolves; we keep showing the placeholder until
   *  the snapshot includes this id, then `creating` is cleared (seamless
   *  hand-off to the real, snapshot-driven row + terminal). */
  sessionId?: string
  error?: string
}

/** A terminal pane identity — a /pty/attach target:
 *  'agent', 'shell:<name>', or 'window:@<id>'. */
export type TerminalTab = string

/** Top-level phase tab: Plan (wiki docs + grill sessions) or Build (the
 *  regular session workspace). */
export type PhaseTab = 'plan' | 'build'

/** Local-only UI state (not daemon state — that lives in the snapshot). */
interface UiState {
  /** Project whose sessions the sidebar is scoped to (rail selection). */
  activeProjectSlug: string | null
  /** Session shown in the main pane. */
  selectedSessionId: string | null
  /** Per-session counter; bumping one forces that terminal to remount +
   *  reattach (e.g. after a restart) without disturbing the others. */
  terminalNonces: Record<string, number>
  /** Per-session workspace layout tree. Missing key = the default single
   *  agent pane; null = an explicitly emptied workspace. */
  layouts: Record<string, LayoutNode | null>
  /** Whether the session sidebar is shown. */
  sidebarOpen: boolean
  /** Top-level Plan | Build tab. */
  phaseTab: PhaseTab
  /** Plan tab: selected wiki doc path (page filename), if any. */
  selectedDocPath: string | null
  /** Tiling WM vs one-at-a-time tabs (persisted; small screens default
   *  to tabs). The layout tree stays canonical in both modes. */
  viewMode: ViewMode
  /** Per-session active terminal in tabs mode. */
  activeTabs: Record<string, string>
  /** A session being provisioned (placeholder shown until it's ready). */
  creating: CreatingSession | null
  /** Sessions whose delete was confirmed — hidden optimistically until the
   *  daemon's (detached) cleanup completes and the snapshot drops them. */
  pendingDeleteIds: string[]
  /** Just-deleted sessions (that had history) shown optimistically in the
   *  Deleted group until the daemon's list-deleted catches up. */
  optimisticDeleted: DeletedSessionEntry[]
  setCreating: (c: CreatingSession | null) => void
  setActiveProject: (slug: string | null) => void
  selectSession: (id: string | null) => void
  /** Jump to a specific session, switching the active project to match. */
  openSession: (projectSlug: string, sessionId: string) => void
  reconnectTerminal: (sessionId: string) => void
  /** Replace a session's workspace layout (trees are built with the pure
   *  helpers in lib/layout). */
  setSessionLayout: (sessionId: string, layout: LayoutNode | null) => void
  toggleSidebar: () => void
  setPhaseTab: (tab: PhaseTab) => void
  selectDoc: (path: string | null) => void
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

export const useUiStore = create<UiState>((set) => ({
  activeProjectSlug: null,
  selectedSessionId: null,
  terminalNonces: {},
  layouts: loadPersistedLayouts(),
  sidebarOpen: true,
  phaseTab: 'build',
  selectedDocPath: null,
  viewMode: loadViewMode(),
  activeTabs: {},
  creating: null,
  pendingDeleteIds: [],
  optimisticDeleted: [],
  setCreating: (c) => set({ creating: c }),
  // Switching projects clears the open session — the sidebar now shows a
  // different project's sessions, so the old selection no longer belongs.
  setActiveProject: (slug) => set({ activeProjectSlug: slug, selectedSessionId: null }),
  selectSession: (id) => set({ selectedSessionId: id }),
  openSession: (projectSlug, sessionId) => set({ activeProjectSlug: projectSlug, selectedSessionId: sessionId }),
  reconnectTerminal: (sessionId) => set((s) => ({
    terminalNonces: { ...s.terminalNonces, [sessionId]: (s.terminalNonces[sessionId] ?? 0) + 1 },
  })),
  setSessionLayout: (sessionId, layout) => set((s) => ({
    layouts: { ...s.layouts, [sessionId]: layout },
  })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setPhaseTab: (tab) => set({ phaseTab: tab }),
  selectDoc: (path) => set({ selectedDocPath: path }),
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
