import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { enableWebglRenderer } from '#lib/webgl-renderer'

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

// Minimal terminal exposing what the helper touches: loadAddon activating
// the addon synchronously, as xterm's AddonManager does on an opened term.
const fakeTerm = (): Terminal =>
  ({ loadAddon: (a: { activate: (t: unknown) => void }): void => a.activate(fakeTerm) }) as unknown as Terminal

beforeEach(() => {
  fake.state.instances.length = 0
  fake.state.activateError = null
})

describe('enableWebglRenderer', () => {
  it('loads the addon and reports success', () => {
    expect(enableWebglRenderer(fakeTerm())).toBe(true)
    expect(fake.state.instances).toHaveLength(1)
    expect(fake.state.instances[0].disposed).toBe(false)
  })

  it('returns false and unregisters the addon when WebGL2 is unavailable', () => {
    fake.state.activateError = new Error('WebGL2 not supported')
    expect(enableWebglRenderer(fakeTerm())).toBe(false)
    // Disposing the half-loaded addon is what removes it from the addon
    // manager, so term.dispose() won't dispose it a second time.
    expect(fake.state.instances[0].disposed).toBe(true)
  })

  it('disposes the addon on context loss so xterm falls back to the DOM renderer', () => {
    expect(enableWebglRenderer(fakeTerm())).toBe(true)
    const addon = fake.state.instances[0]
    addon.fireContextLoss()
    expect(addon.disposed).toBe(true)
  })
})
