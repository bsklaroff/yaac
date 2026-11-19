import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type * as PlatformModule from '#lib/platform'

// Whether the shell hides the native title bar (macOS); a getter over this
// lets a case flip it.
const platform = vi.hoisted(() => ({ hides: true }))
vi.mock('#lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformModule>()),
  hidesTitleBar: () => platform.hides,
}))

import { YWindowControls } from '#ui'

afterEach(() => {
  cleanup()
  delete (window as unknown as { yaacWindow?: unknown }).yaacWindow
  platform.hides = true
})

const inject = (bridge: unknown): void => {
  ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = bridge
}

const bridge = (): { minimize: () => void; toggleMaximize: (alt?: boolean) => void; close: () => void } =>
  ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() })

describe('YWindowControls', () => {
  it('wires each button to the bridge', () => {
    const b = bridge()
    inject(b)
    render(<YWindowControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom window' }))
    expect(b.close).toHaveBeenCalledOnce()
    expect(b.minimize).toHaveBeenCalledOnce()
    expect(b.toggleMaximize).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('forwards Option-click on the zoom button as altKey', () => {
    const b = bridge()
    inject(b)
    render(<YWindowControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom window' }), { altKey: true })
    expect(b.toggleMaximize).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('draws nothing without the desktop bridge, as in a preview pane', () => {
    const { container } = render(<YWindowControls />)
    expect(container.innerHTML).toBe('')
  })

  it('draws nothing where the shell keeps the native frame', () => {
    platform.hides = false
    inject(bridge())
    const { container } = render(<YWindowControls />)
    expect(container.innerHTML).toBe('')
  })
})
