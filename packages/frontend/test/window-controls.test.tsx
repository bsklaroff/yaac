// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type * as PlatformModule from '#lib/platform'

// IS_MAC is read once at load; a getter over this lets a case flip it.
const platform = vi.hoisted(() => ({ IS_MAC: false }))
vi.mock('#lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformModule>()),
  get IS_MAC() { return platform.IS_MAC },
}))

import { WindowControls, windowApi } from '#components/WindowControls'

afterEach(() => {
  cleanup()
  delete (window as unknown as { yaacWindow?: unknown }).yaacWindow
})

const inject = (bridge: unknown): void => {
  ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = bridge
}

describe('windowApi', () => {
  it('is undefined without the bridge', () => {
    expect(windowApi()).toBeUndefined()
  })

  it('returns the injected bridge', () => {
    const bridge = { minimize() {}, toggleMaximize() {}, close() {} }
    inject(bridge)
    expect(windowApi()).toBe(bridge)
  })
})

describe('WindowControls', () => {
  it('wires each button to the bridge', () => {
    const bridge = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }
    inject(bridge)
    render(<WindowControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom window' }))
    expect(bridge.close).toHaveBeenCalledOnce()
    expect(bridge.minimize).toHaveBeenCalledOnce()
    expect(bridge.toggleMaximize).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('forwards Option-click on the zoom button as altKey', () => {
    const bridge = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }
    inject(bridge)
    render(<WindowControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom window' }), { altKey: true })
    expect(bridge.toggleMaximize).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('labels the zoom button for the platform', () => {
    render(<WindowControls />)
    expect(screen.getByRole('button', { name: 'Zoom window' }).getAttribute('title')).toBe('Zoom')
    cleanup()
    platform.IS_MAC = true
    try {
      render(<WindowControls />)
      expect(screen.getByRole('button', { name: 'Zoom window' }).getAttribute('title'))
        .toBe('Full screen (⌥ to zoom)')
    } finally {
      platform.IS_MAC = false
    }
  })

  it('does not throw when the bridge is absent', () => {
    render(<WindowControls />)
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Close window' }))).not.toThrow()
  })
})
