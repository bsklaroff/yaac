// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { createWebglController } from '#lib/webgl-renderer'

// Same controllable WebglAddon stand-in as webgl-renderer.test.ts: the real
// addon needs a live WebGL2 context. Here we drive the *tab* visibility path
// (document.visibilityState), which the node-env sibling file can't reach.
const fake = vi.hoisted(() => {
  const state = {
    instances: [] as InstanceType<typeof WebglAddon>[],
    activateError: null as Error | null,
  }
  class WebglAddon {
    public disposed = false
    private _onLoss: Array<() => void> = []
    public onContextLoss(cb: () => void): { dispose: () => void } {
      this._onLoss.push(cb)
      return { dispose: (): void => {} }
    }
    public activate(): void {
      if (state.activateError) throw state.activateError
    }
    public dispose(): void {
      this.disposed = true
    }
    public fireContextLoss(): void {
      for (const cb of this._onLoss) cb()
    }
    constructor() {
      state.instances.push(this)
    }
  }
  return { state, WebglAddon }
})

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: fake.WebglAddon }))

interface FakeTerm {
  term: Terminal
  refreshes: Array<[number, number]>
}
const fakeTerm = (): FakeTerm => {
  const refreshes: Array<[number, number]> = []
  const term = {
    rows: 24,
    loadAddon: (a: { activate: (t: unknown) => void }): void => a.activate(term),
    refresh: (start: number, end: number): void => { refreshes.push([start, end]) },
  } as unknown as Terminal
  return { term, refreshes }
}

const last = (): InstanceType<typeof fake.WebglAddon> =>
  fake.state.instances[fake.state.instances.length - 1]

// Drive the Page Visibility API the way a browser does: jsdom's
// visibilityState is a read-only getter, so override it and dispatch the event.
let visibility: DocumentVisibilityState = 'visible'
const setTab = (state: DocumentVisibilityState): void => {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  fake.state.instances.length = 0
  fake.state.activateError = null
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createWebglController — tab visibility', () => {
  it('releases the context when the tab is backgrounded even while the pane is visible', () => {
    const ctl = createWebglController(fakeTerm().term)
    ctl.setVisible(true)
    expect(last().disposed).toBe(false)
    // The pane is still "visible" within the app, but the whole tab hid.
    setTab('hidden')
    expect(last().disposed).toBe(true)
    ctl.dispose()
  })

  it('rebuilds a fresh context and repaints when the tab returns to the foreground', () => {
    const { term, refreshes } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    setTab('hidden')
    refreshes.length = 0
    setTab('visible')
    // A brand-new addon (the old one was released on background) plus a full
    // repaint — this is what kills the "black box on tab-return" symptom.
    expect(fake.state.instances).toHaveLength(2)
    expect(last().disposed).toBe(false)
    expect(refreshes).toEqual([[0, 23]])
    ctl.dispose()
  })

  it('does not acquire a context for a hidden pane when the tab returns', () => {
    const ctl = createWebglController(fakeTerm().term)
    // Pane never shown; only the tab flips.
    setTab('hidden')
    setTab('visible')
    expect(fake.state.instances).toHaveLength(0)
    ctl.dispose()
  })

  it('does not re-acquire on a context loss suffered while backgrounded', () => {
    const ctl = createWebglController(fakeTerm().term)
    ctl.setVisible(true)
    const live = last()
    setTab('hidden')
    // Backgrounding already released it; a late loss event must not spawn a
    // doomed replacement (rAF is paused — nothing could paint it anyway).
    live.fireContextLoss()
    expect(fake.state.instances).toHaveLength(1)
    ctl.dispose()
  })

  it('gives the returning tab a clean loss budget after a backgrounded thrash', () => {
    const { term } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    // Burn the budget while foreground so the controller has given up on WebGL.
    for (let i = 0; i < 6; i++) last().fireContextLoss()
    expect(fake.state.instances).toHaveLength(4)
    // A tab hide/show is a fresh start, exactly like an in-app hide/show.
    setTab('hidden')
    setTab('visible')
    expect(fake.state.instances).toHaveLength(5)
    expect(last().disposed).toBe(false)
    ctl.dispose()
  })

  it('stops reacting to tab visibility after dispose', () => {
    const ctl = createWebglController(fakeTerm().term)
    ctl.setVisible(true)
    ctl.dispose()
    const n = fake.state.instances.length
    setTab('hidden')
    setTab('visible')
    // The listener was removed on dispose: no new addons, no touching a
    // disposed terminal.
    expect(fake.state.instances).toHaveLength(n)
  })

  it('holds one context per (pane-visible AND tab-visible); drops it if either is false', () => {
    const ctl = createWebglController(fakeTerm().term)
    expect(fake.state.instances).toHaveLength(0) // neither
    ctl.setVisible(true) // pane yes, tab yes -> hold
    expect(last().disposed).toBe(false)
    setTab('hidden') // tab no -> drop
    expect(last().disposed).toBe(true)
    setTab('visible') // both yes -> hold (fresh)
    expect(last().disposed).toBe(false)
    ctl.setVisible(false) // pane no -> drop
    expect(last().disposed).toBe(true)
    ctl.dispose()
  })
})
