import { describe, it, expect } from 'vitest'
import { patchClickForwarding, patchForcedSelection, patchKeepSelection } from '#lib/selection'
import type { CoreMouseEvent, XtermCore } from '#lib/xterm-internals'
import { fakeXterm } from './harness'

describe('patchForcedSelection', () => {
  it('selects locally on a plain drag and hands Alt+drag to the app', () => {
    const term = fakeXterm()
    patchForcedSelection(term)
    const svc = (term as unknown as { _core: XtermCore })._core._selectionService
    expect(svc.shouldForceSelection(new MouseEvent('mousedown'))).toBe(true)
    expect(svc.shouldForceSelection(new MouseEvent('mousedown', { altKey: true }))).toBe(false)
  })
})

describe('patchClickForwarding', () => {
  type Sent = Pick<CoreMouseEvent, 'col' | 'row' | 'button' | 'action'>

  const fake = (mouseActive = true): {
    term: ReturnType<typeof fakeXterm>
    el: HTMLElement
    sent: Sent[]
    setSelection: (v: boolean) => void
  } => {
    const el = document.createElement('div')
    const sent: Sent[] = []
    let hasSelection = false
    const term = fakeXterm({
      element: el,
      // `this`-using, like the real service, so the patch must call it as a method.
      coreMouseService: {
        areMouseEventsActive: mouseActive,
        _sink: sent,
        triggerMouseEvent(e: CoreMouseEvent): boolean {
          this._sink.push({ col: e.col, row: e.row, button: e.button, action: e.action })
          return true
        },
        consumeWheelEvent: () => 0,
      } as XtermCore['coreMouseService'] & { _sink: Sent[] },
    }, { hasSelection: () => hasSelection })
    return { term, el, sent, setSelection: (v) => (hasSelection = v) }
  }

  const click = (el: HTMLElement, down: MouseEventInit = {}): void => {
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0, ...down }))
    // The release may land outside the terminal.
    document.dispatchEvent(new MouseEvent('mouseup'))
  }

  it('forwards a plain click as a press then release at the clicked cell', () => {
    const { term, el, sent } = fake()
    patchClickForwarding(term)
    click(el)
    expect(sent).toEqual([
      { col: 3, row: 4, button: 0, action: 1 }, // DOWN
      { col: 3, row: 4, button: 0, action: 0 }, // UP
    ])
  })

  it('does not forward when a drag or word-select made a selection', () => {
    const { term, el, sent, setSelection } = fake()
    patchClickForwarding(term)
    setSelection(true)
    click(el)
    expect(sent).toEqual([])
  })

  it('does not forward a modified or non-primary click', () => {
    const { term, el, sent } = fake()
    patchClickForwarding(term)
    // Alt already reports itself; Cmd and Ctrl open links.
    click(el, { altKey: true })
    click(el, { metaKey: true })
    click(el, { ctrlKey: true })
    click(el, { button: 2 })
    expect(sent).toEqual([])
  })

  it('does not forward when the app is not tracking the mouse', () => {
    const { term, el, sent } = fake(false)
    patchClickForwarding(term)
    click(el)
    expect(sent).toEqual([])
  })

  it('unbinds both listeners when disposed', () => {
    const { term, el, sent } = fake()
    patchClickForwarding(term)()
    click(el)
    expect(sent).toEqual([])
  })
})

describe('patchKeepSelection', () => {
  // Mimics xterm: triggerDataEvent synchronously clears the selection, and so
  // does disable() (called on every mouse-protocol DECSET).
  const fakeTerm = (): {
    svc: { clearSelection: () => void; disable: () => void; cleared: number; enabled: boolean }
    coreService: { triggerDataEvent: (data: string, wasUserInput?: boolean) => void; sent: string[] }
    term: ReturnType<typeof fakeXterm>
  } => {
    const svc = {
      cleared: 0,
      enabled: true,
      shouldForceSelection: () => false,
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
    return { svc, coreService, term: fakeXterm({ _selectionService: svc, coreService }) }
  }

  it('drops the clear fired while input is sent, but still sends the data', () => {
    const { svc, coreService, term } = fakeTerm()
    patchKeepSelection(term)
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
})
