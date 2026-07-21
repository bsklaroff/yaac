import { describe, it, expect } from 'vitest'
import { injectPreviewLeaf, injectPaneLeaf } from '#store'
import { addColumn, paneTargets, singleColumn } from '#lib/layout'
import { PREVIEW_TARGET, isPreviewTarget } from '#lib/preview'
import { CHANGES_TARGET } from '#lib/changesApi'

describe('injectPreviewLeaf', () => {
  it('opens the preview as a new column beside the agent', () => {
    const next = injectPreviewLeaf(singleColumn('agent'))
    expect(next).toEqual([
      { tabs: ['agent'], active: 'agent' },
      { tabs: [PREVIEW_TARGET], active: PREVIEW_TARGET },
    ])
  })

  it('adds a preview column when there is no agent pane', () => {
    const base = addColumn(singleColumn('window:@1'), 'window:@2')
    const next = injectPreviewLeaf(base)
    expect(paneTargets(next).filter(isPreviewTarget)).toEqual([PREVIEW_TARGET])
  })

  it('is a no-op when a preview already exists', () => {
    const base = addColumn(singleColumn('agent'), PREVIEW_TARGET)
    expect(injectPreviewLeaf(base)).toBe(base)
  })

  it('treats a null layout as a fresh agent workspace', () => {
    expect(paneTargets(injectPreviewLeaf(null))).toEqual(['agent', PREVIEW_TARGET])
  })
})

describe('injectPaneLeaf', () => {
  it('adds an arbitrary special pane as a column beside the agent', () => {
    expect(paneTargets(injectPaneLeaf(singleColumn('agent'), CHANGES_TARGET))).toEqual(['agent', CHANGES_TARGET])
  })
  it('is a no-op when that pane already exists', () => {
    const base = addColumn(singleColumn('agent'), CHANGES_TARGET)
    expect(injectPaneLeaf(base, CHANGES_TARGET)).toBe(base)
  })
})
