import { create } from 'zustand'

/** Local-only UI state (not daemon state — that lives in the snapshot). */
interface UiState {
  selectedSessionId: string | null
  selectSession: (id: string | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  selectedSessionId: null,
  selectSession: (id) => set({ selectedSessionId: id }),
}))
