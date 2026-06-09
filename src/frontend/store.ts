import { create } from 'zustand'

/** Local-only UI state (not daemon state — that lives in the snapshot). */
interface UiState {
  /** Project whose sessions the sidebar is scoped to (rail selection). */
  activeProjectSlug: string | null
  /** Session shown in the main pane. */
  selectedSessionId: string | null
  setActiveProject: (slug: string | null) => void
  selectSession: (id: string | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  activeProjectSlug: null,
  selectedSessionId: null,
  // Switching projects clears the open session — the sidebar now shows a
  // different project's sessions, so the old selection no longer belongs.
  setActiveProject: (slug) => set({ activeProjectSlug: slug, selectedSessionId: null }),
  selectSession: (id) => set({ selectedSessionId: id }),
}))
