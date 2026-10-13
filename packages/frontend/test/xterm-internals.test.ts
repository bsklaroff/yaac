import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { xtermCore } from '#lib/xterm-internals'

describe('xtermCore', () => {
  // The terminal patches reach into these private names, so an xterm
  // upgrade that renames one must fail here rather than in the browser.
  it('finds every private member on the pinned xterm, and names what is missing', () => {
    const term = new Terminal()
    term.open(document.createElement('div'))
    expect(() => xtermCore(term)).not.toThrow()
    term.dispose()

    const bare = { _core: { element: document.createElement('div') } } as unknown as Terminal
    expect(() => xtermCore(bare)).toThrow(/missing: screenElement, _selectionService\.shouldForceSelection/)
  })
})
