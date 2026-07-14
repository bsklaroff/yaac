import { describe, it, expect } from 'vitest'
import { injectPreviewLeaf, injectPaneLeaf } from '#store'
import { leaf, splitLeaf, leafTargets } from '#lib/layout'
import { PREVIEW_TARGET, isPreviewTarget } from '#lib/preview'
import { CHANGES_TARGET } from '#lib/changesApi'

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

describe('injectPaneLeaf', () => {
  it('adds an arbitrary special leaf beside the agent', () => {
    expect(leafTargets(injectPaneLeaf(leaf('agent'), CHANGES_TARGET))).toEqual(['agent', CHANGES_TARGET])
  })
  it('is a no-op when that leaf already exists', () => {
    const base = splitLeaf(leaf('agent'), 'agent', CHANGES_TARGET, 'row')
    expect(injectPaneLeaf(base, CHANGES_TARGET)).toBe(base)
  })
})
