import { create } from 'zustand'
import type { AgentTool, DeletedSessionEntry } from '@/shared/types'

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

/** Local-only UI state (not daemon state — that lives in the snapshot). */
interface UiState {
  /** Project whose sessions the sidebar is scoped to (rail selection). */
  activeProjectSlug: string | null
  /** Session shown in the main pane. */
  selectedSessionId: string | null
  /** Per-session counter; bumping one forces that terminal to remount +
   *  reattach (e.g. after a restart) without disturbing the others. */
  terminalNonces: Record<string, number>
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
