import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  forceLocalSelection,
  patchClickForwarding,
  patchForcedSelection,
  patchKeepSelection,
} from '#lib/selection'

describe('forceLocalSelection', () => {
  it('selects locally on a plain drag', () => {
    expect(forceLocalSelection({ altKey: false })).toBe(true)
  })

  it('hands Alt+drag to tmux', () => {
    expect(forceLocalSelection({ altKey: true })).toBe(false)
  })
})

describe('patchForcedSelection', () => {
  it('replaces the selection-service predicate', () => {
    const svc = { shouldForceSelection: (_e: MouseEvent): boolean => false }
    const term = { _core: { _selectionService: svc } } as unknown as Terminal
    expect(patchForcedSelection(term)).toBe(true)
    expect(svc.shouldForceSelection({ altKey: false } as MouseEvent)).toBe(true)
    expect(svc.shouldForceSelection({ altKey: true } as MouseEvent)).toBe(false)
  })

  it('reports failure without throwing when the internals are missing', () => {
    expect(patchForcedSelection({} as Terminal)).toBe(false)
    expect(patchForcedSelection({ _core: {} } as unknown as Terminal)).toBe(false)
  })

  // Canaries for the pinned dependency: the patches reach into private xterm
  // internals, so an upgrade that renames or mangles them must fail here
  // rather than silently reverting the webapp to modifier-to-select.
  it('finds _core on a real Terminal instance', () => {
    const term = new Terminal()
    expect((term as unknown as { _core?: object })._core).toBeDefined()
  })

  it('still finds the private names in the shipped xterm bundle', () => {
    const require = createRequire(import.meta.url)
    const bundle = readFileSync(require.resolve('@xterm/xterm'), 'utf8')
    expect(bundle).toContain('_selectionService')
    expect(bundle).toContain('shouldForceSelection')
    expect(bundle).toContain('clearSelection')
    expect(bundle).toContain('coreService')
    expect(bundle).toContain('triggerDataEvent')
  })
})

describe('patchClickForwarding', () => {
  type MouseListener = (e: MouseEvent) => void
  type FakeEl = {
    addEventListener: (type: string, fn: MouseListener) => void
    removeEventListener: (type: string, fn: MouseListener) => void
    dispatch: (type: string, e: Partial<MouseEvent>) => void
    count: (type: string) => number
  }
  const fakeEl = (): FakeEl => {
    const listeners: Record<string, Set<MouseListener>> = {}
    return {
      addEventListener(type, fn): void {
        ;(listeners[type] ??= new Set()).add(fn)
      },
      removeEventListener(type, fn): void {
        listeners[type]?.delete(fn)
      },
      dispatch(type, e): void {
        listeners[type]?.forEach((fn) => fn(e as MouseEvent))
      },
      count(type): number {
        return listeners[type]?.size ?? 0
      },
    }
  }

  type Sent = { col: number; row: number; button: number; action: number }
  const fake = (
    opts: { mouseActive?: boolean } = {},
  ): {
    term: Terminal
    el: FakeEl
    doc: FakeEl
    sent: Sent[]
    setSelection: (v: boolean) => void
  } => {
    const el = fakeEl()
    const doc = fakeEl()
    const sent: Sent[] = []
    let hasSelection = false
    const term = {
      hasSelection: () => hasSelection,
      _core: {
        // Listeners bind to element; screenElement only feeds coordinates.
        element: { ...el, ownerDocument: doc },
        screenElement: { addEventListener() {}, removeEventListener() {} },
        // These read `this` (like the real services), so the patch must call
        // them bound — a bare-reference call would throw here.
        _mouseService: {
          _coords: { col: 4, row: 2, x: 40, y: 20 },
          getMouseReportCoords(): { col: number; row: number; x: number; y: number } {
            return this._coords
          },
        },
        coreMouseService: {
          areMouseEventsActive: opts.mouseActive ?? true,
          _sink: sent,
          triggerMouseEvent(e: Sent): boolean {
            this._sink.push({ col: e.col, row: e.row, button: e.button, action: e.action })
            return true
          },
        },
      },
    } as unknown as Terminal
    // element is a shallow copy, so bind listeners on the same object the patch
    // will (its addEventListener closes over `el`'s listener map).
    return { term, el, doc, sent, setSelection: (v) => (hasSelection = v) }
  }

  const click = (el: FakeEl, doc: FakeEl, down: Partial<MouseEvent> = {}): void => {
    el.dispatch('mousedown', { button: 0, altKey: false, ...down })
    doc.dispatch('mouseup', {})
  }

  it('forwards a plain click as a press then release at the clicked cell', () => {
    const { term, el, doc, sent } = fake()
    expect(patchClickForwarding(term)).toBeTypeOf('function')
    click(el, doc)
    expect(sent).toEqual([
      { col: 4, row: 2, button: 0, action: 1 }, // DOWN
      { col: 4, row: 2, button: 0, action: 0 }, // UP
    ])
  })

  it('does not forward when a drag or word-select made a selection', () => {
    const { term, el, doc, sent, setSelection } = fake()
    patchClickForwarding(term)
    setSelection(true)
    click(el, doc)
    expect(sent).toEqual([])
  })

  it('does not forward an Alt+click (that gesture already reports itself)', () => {
    const { term, el, doc, sent } = fake()
    patchClickForwarding(term)
    click(el, doc, { altKey: true })
    expect(sent).toEqual([])
  })

  it('does not forward a non-primary button', () => {
    const { term, el, doc, sent } = fake()
    patchClickForwarding(term)
    click(el, doc, { button: 2 })
    expect(sent).toEqual([])
  })

  it('does not forward when the app is not tracking the mouse', () => {
    const { term, el, doc, sent } = fake({ mouseActive: false })
    patchClickForwarding(term)
    click(el, doc)
    expect(sent).toEqual([])
  })

  it('unbinds both listeners when disposed', () => {
    const { term, el, doc, sent } = fake()
    const dispose = patchClickForwarding(term)
    expect(dispose).toBeTypeOf('function')
    dispose!()
    expect(el.count('mousedown')).toBe(0)
    expect(doc.count('mouseup')).toBe(0)
    click(el, doc)
    expect(sent).toEqual([])
  })

  it('reports failure without throwing when the internals are missing', () => {
    expect(patchClickForwarding({} as Terminal)).toBeNull()
    expect(patchClickForwarding({ _core: {} } as unknown as Terminal)).toBeNull()
    // screenElement present but the mouse services are not.
    expect(
      patchClickForwarding({
        _core: { screenElement: fakeEl() },
      } as unknown as Terminal),
    ).toBeNull()
  })

  // Canaries for the pinned dependency, like the patchForcedSelection ones: an
  // xterm upgrade that renames these must fail here, not silently send clicks
  // back to needing Alt.
  it('finds coreMouseService on a real Terminal instance', () => {
    const term = new Terminal()
    const core = (term as unknown as { _core?: { coreMouseService?: object } })._core
    expect(core?.coreMouseService).toBeDefined()
  })

  it('still finds the private names in the shipped xterm bundle', () => {
    const require = createRequire(import.meta.url)
    const bundle = readFileSync(require.resolve('@xterm/xterm'), 'utf8')
    expect(bundle).toContain('screenElement')
    expect(bundle).toContain('_mouseService')
    expect(bundle).toContain('getMouseReportCoords')
    expect(bundle).toContain('coreMouseService')
    expect(bundle).toContain('triggerMouseEvent')
    expect(bundle).toContain('areMouseEventsActive')
  })
})

describe('patchKeepSelection', () => {
  // Mimics the xterm wiring: sending user input synchronously fires the
  // selection-clearing listener from inside triggerDataEvent, and disable()
  // (called on every mouse-protocol DECSET) clears too.
  const fakeTerm = (): {
    svc: { clearSelection: () => void; disable: () => void; cleared: number; enabled: boolean }
    coreService: { triggerDataEvent: (data: string, wasUserInput?: boolean) => void; sent: string[] }
    term: Terminal
  } => {
    const svc = {
      cleared: 0,
      enabled: true,
      clearSelection(): void {
        this.cleared++
      },
      disable(): void {
        this.clearSelection()
        this.enabled = false
      },
    }
    const coreService = {
      sent: [] as string[],
      triggerDataEvent(data: string, wasUserInput?: boolean): void {
        this.sent.push(data)
        if (wasUserInput) svc.clearSelection()
      },
    }
    return {
      svc,
      coreService,
      term: { _core: { _selectionService: svc, coreService } } as unknown as Terminal,
    }
  }

  it('drops the clear fired while input is sent, but still sends the data', () => {
    const { svc, coreService, term } = fakeTerm()
    expect(patchKeepSelection(term)).toBe(true)
    coreService.triggerDataEvent('\x1b[B', true) // arrow key
    coreService.triggerDataEvent('\x1b[<35;10;5M', true) // mouse motion report
    expect(coreService.sent).toEqual(['\x1b[B', '\x1b[<35;10;5M'])
    expect(svc.cleared).toBe(0)
  })

  it('drops the clear inside disable() but keeps its bookkeeping', () => {
    const { svc, term } = fakeTerm()
    patchKeepSelection(term)
    svc.disable() // protocol (re-)assert path
    expect(svc.cleared).toBe(0)
    expect(svc.enabled).toBe(false)
  })

  it('lets clears from other sources (mouse, resize, reset) pass through', () => {
    const { svc, coreService, term } = fakeTerm()
    patchKeepSelection(term)
    coreService.triggerDataEvent('x', true)
    svc.disable()
    svc.clearSelection()
    expect(svc.cleared).toBe(1)
  })

  it('stops suppressing even if sending throws', () => {
    const { svc, coreService, term } = fakeTerm()
    coreService.triggerDataEvent = (): void => {
      throw new Error('socket gone')
    }
    patchKeepSelection(term)
    expect(() => coreService.triggerDataEvent('x', true)).toThrow('socket gone')
    svc.clearSelection()
    expect(svc.cleared).toBe(1)
  })

  it('reports failure without throwing when the internals are missing', () => {
    expect(patchKeepSelection({} as Terminal)).toBe(false)
    expect(patchKeepSelection({ _core: {} } as unknown as Terminal)).toBe(false)
    const { svc } = fakeTerm()
    expect(patchKeepSelection({ _core: { _selectionService: svc } } as unknown as Terminal)).toBe(
      false,
    )
  })
})
