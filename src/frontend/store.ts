import { create } from 'zustand'

/** Local-only UI state (not daemon state — that lives in the snapshot). */
interface UiState {
  /** Project whose sessions the sidebar is scoped to (rail selection). */
  activeProjectSlug: string | null
  /** Session shown in the main pane. */
  selectedSessionId: string | null
  /** Per-session counter; bumping one forces that terminal to remount +
   *  reattach (e.g. after a restart) without disturbing the others. */
  terminalNonces: Record<string, number>
  setActiveProject: (slug: string | null) => void
  selectSession: (id: string | null) => void
  /** Jump to a specific session, switching the active project to match. */
  openSession: (projectSlug: string, sessionId: string) => void
  reconnectTerminal: (sessionId: string) => void
}

export const useUiStore = create<UiState>((set) => ({
  activeProjectSlug: null,
  selectedSessionId: null,
  terminalNonces: {},
  // Switching projects clears the open session — the sidebar now shows a
  // different project's sessions, so the old selection no longer belongs.
  setActiveProject: (slug) => set({ activeProjectSlug: slug, selectedSessionId: null }),
  selectSession: (id) => set({ selectedSessionId: id }),
  openSession: (projectSlug, sessionId) => set({ activeProjectSlug: projectSlug, selectedSessionId: sessionId }),
  reconnectTerminal: (sessionId) => set((s) => ({
    terminalNonces: { ...s.terminalNonces, [sessionId]: (s.terminalNonces[sessionId] ?? 0) + 1 },
  })),
}))
