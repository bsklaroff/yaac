import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, loadEditorFontSize, useUiStore,
} from '#store'

// Minimal localStorage stand-in for the node test environment.
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  }
  return store
}

describe('editor font size persistence', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = stubLocalStorage()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('defaults when unset, blank or unparseable, and without localStorage', () => {
    expect(loadEditorFontSize()).toBe(DEFAULT_EDITOR_FONT_SIZE)
    store.set('yaac.editorfontsize.v1', ' ')
    expect(loadEditorFontSize()).toBe(DEFAULT_EDITOR_FONT_SIZE)
    store.set('yaac.editorfontsize.v1', 'big')
    expect(loadEditorFontSize()).toBe(DEFAULT_EDITOR_FONT_SIZE)
    delete (globalThis as Record<string, unknown>).localStorage
    expect(loadEditorFontSize()).toBe(DEFAULT_EDITOR_FONT_SIZE)
  })

  it('the setter clamps, persists, and the persisted size loads back', () => {
    useUiStore.getState().setEditorFontSize(15)
    expect(useUiStore.getState().editorFontSize).toBe(15)
    expect(loadEditorFontSize()).toBe(15)
    useUiStore.getState().setEditorFontSize(100)
    expect(useUiStore.getState().editorFontSize).toBe(MAX_EDITOR_FONT_SIZE)
    useUiStore.getState().setEditorFontSize(1)
    expect(store.get('yaac.editorfontsize.v1')).toBe(String(MIN_EDITOR_FONT_SIZE))
    store.set('yaac.editorfontsize.v1', '400')
    expect(loadEditorFontSize()).toBe(MAX_EDITOR_FONT_SIZE)
  })
})
