import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { createWebglController } from '#lib/webgl-renderer'

// Stand-in for WebglAddon: the real one needs a live WebGL2 context (it
// throws from activate without one — the exact failure mode the fallback
// path exists for), so substitute a controllable fake and drive both
// outcomes from the tests.
const fake = vi.hoisted(() => {
  const state = {
    instances: [] as InstanceType<typeof WebglAddon>[],
    activateError: null as Error | null,
  }
  class WebglAddon {
    public disposed = false
    private _onLoss: Array<() => void> = []
    constructor() {
      state.instances.push(this)
    }
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
  }
  return { state, WebglAddon }
})

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: fake.WebglAddon }))

// Minimal terminal exposing what the controller touches: loadAddon activating
// the addon synchronously (as xterm's AddonManager does on an opened term) and
// a refresh spy so tests can assert the on-show / on-recover repaint.
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

/** The most recently constructed fake addon. */
const last = (): InstanceType<typeof fake.WebglAddon> =>
  fake.state.instances[fake.state.instances.length - 1]

beforeEach(() => {
  fake.state.instances.length = 0
  fake.state.activateError = null
})

describe('createWebglController', () => {
  it('loads the addon and repaints when the pane becomes visible', () => {
    const { term, refreshes } = fakeTerm()
    createWebglController(term).setVisible(true)
    expect(fake.state.instances).toHaveLength(1)
    expect(last().disposed).toBe(false)
    expect(refreshes).toEqual([[0, 23]])
  })

  it('does not touch WebGL while the pane stays hidden', () => {
    const { term } = fakeTerm()
    createWebglController(term).setVisible(false)
    expect(fake.state.instances).toHaveLength(0)
  })

  it('frees the context when the pane is hidden', () => {
    const { term } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    ctl.setVisible(false)
    expect(last().disposed).toBe(true)
  })

  it('acquires a fresh context on each re-show', () => {
    const { term } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    ctl.setVisible(false)
    ctl.setVisible(true)
    expect(fake.state.instances).toHaveLength(2)
    expect(fake.state.instances[0].disposed).toBe(true)
    expect(fake.state.instances[1].disposed).toBe(false)
  })

  it('is idempotent on repeated same-value setVisible calls', () => {
    const { term } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    ctl.setVisible(true)
    expect(fake.state.instances).toHaveLength(1)
  })

  it('unregisters the addon and stops retrying when WebGL2 is unavailable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.state.activateError = new Error('WebGL2 not supported')
    const { term } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    // Disposing the half-loaded addon removes it from the addon manager so
    // term.dispose() won't dispose it twice.
    expect(fake.state.instances).toHaveLength(1)
    expect(fake.state.instances[0].disposed).toBe(true)
    // Latched: a later hide/show must not keep spawning doomed contexts.
    ctl.setVisible(false)
    ctl.setVisible(true)
    expect(fake.state.instances).toHaveLength(1)
  })

  it('re-acquires a context and repaints on loss while visible', () => {
    const { term, refreshes } = fakeTerm()
    createWebglController(term).setVisible(true)
    refreshes.length = 0
    last().fireContextLoss()
    expect(fake.state.instances).toHaveLength(2)
    expect(fake.state.instances[0].disposed).toBe(true)
    expect(fake.state.instances[1].disposed).toBe(false)
    expect(refreshes).toEqual([[0, 23]])
  })

  it('does not re-acquire a context on loss while hidden', () => {
    const { term } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    const addon = last()
    ctl.setVisible(false)
    addon.fireContextLoss()
    // Only the disposed original; hiding already released the context.
    expect(fake.state.instances).toHaveLength(1)
  })

  it('stops re-acquiring after repeated losses to avoid GPU thrash', () => {
    const { term } = fakeTerm()
    createWebglController(term).setVisible(true)
    // Keep losing the freshly-made context; recreation is capped at 3.
    for (let i = 0; i < 6; i++) last().fireContextLoss()
    // original + 3 recreations, then it gives up.
    expect(fake.state.instances).toHaveLength(4)
  })

  it('refills the loss budget for well-separated losses (sleep/wake, not thrash)', () => {
    vi.useFakeTimers()
    try {
      const { term } = fakeTerm()
      createWebglController(term).setVisible(true)
      // Losses hours apart are independent incidents — each gets a fresh
      // context instead of slowly exhausting the burst cap.
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(31_000)
        last().fireContextLoss()
      }
      expect(fake.state.instances).toHaveLength(7)
      expect(last().disposed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the loss budget on the next show', () => {
    const { term } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    for (let i = 0; i < 6; i++) last().fireContextLoss()
    expect(fake.state.instances).toHaveLength(4)
    // A deliberate hide/show is a fresh start: WebGL is allowed to try again.
    ctl.setVisible(false)
    ctl.setVisible(true)
    expect(fake.state.instances).toHaveLength(5)
    expect(last().disposed).toBe(false)
  })

  it('releases the context on dispose and ignores later setVisible', () => {
    const { term } = fakeTerm()
    const ctl = createWebglController(term)
    ctl.setVisible(true)
    ctl.dispose()
    expect(last().disposed).toBe(true)
    ctl.setVisible(true)
    expect(fake.state.instances).toHaveLength(1)
  })
})
