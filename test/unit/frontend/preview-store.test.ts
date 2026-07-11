import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadPreviewHandled, persistPreviewHandled, injectPreviewLeaf } from '@/frontend/store'
import { leaf, splitLeaf, leafTargets } from '@/frontend/lib/layout'
import { PREVIEW_TARGET, isPreviewTarget } from '@/frontend/lib/preview'

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  }
  return store
}

describe('preview-handled persistence', () => {
  let store: Map<string, string>
  beforeEach(() => { store = stubLocalStorage() })
  afterEach(() => { delete (globalThis as Record<string, unknown>).localStorage })

  it('round-trips the handled set', () => {
    persistPreviewHandled({ a: true, b: true })
    expect(loadPreviewHandled()).toEqual({ a: true, b: true })
  })

  it('drops non-true values and survives garbage', () => {
    store.set('yaac.previewhandled.v1', JSON.stringify({ a: true, b: false, c: 1 }))
    expect(loadPreviewHandled()).toEqual({ a: true })
    store.set('yaac.previewhandled.v1', '{{{')
    expect(loadPreviewHandled()).toEqual({})
    store.set('yaac.previewhandled.v1', '["a"]')
    expect(loadPreviewHandled()).toEqual({})
  })
})

describe('injectPreviewLeaf', () => {
  it('splits the agent pane, preview to its right', () => {
    const next = injectPreviewLeaf(leaf('agent'))
    expect(next).toEqual({
      type: 'split', dir: 'row', ratio: 0.5,
      a: { type: 'leaf', target: 'agent' },
      b: { type: 'leaf', target: PREVIEW_TARGET },
    })
  })

  it('adds a preview to the largest pane when there is no agent leaf', () => {
    const base = splitLeaf(leaf('window:@1'), 'window:@1', 'window:@2', 'row')
    const next = injectPreviewLeaf(base)
    expect(leafTargets(next).filter(isPreviewTarget)).toEqual([PREVIEW_TARGET])
  })

  it('is a no-op when a preview already exists', () => {
    const base = splitLeaf(leaf('agent'), 'agent', PREVIEW_TARGET, 'row')
    expect(injectPreviewLeaf(base)).toBe(base)
  })

  it('treats a null layout as a fresh agent workspace', () => {
    expect(leafTargets(injectPreviewLeaf(null))).toEqual(['agent', PREVIEW_TARGET])
  })
})
