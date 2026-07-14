import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  forceLocalSelection,
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
