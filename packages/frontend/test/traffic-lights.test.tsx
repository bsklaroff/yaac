import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { YTrafficLights } from '#ui'

/* The platform is read once, when the modules load, so the Mac user agent
 * is in place before any import. */
vi.hoisted(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Electron/33.0.0',
  })
})

const bridge = (kind: string): unknown => ({ app: { kind }, openExternal() {}, showServers() {} })
const leavesRoom = (yaacWindow?: unknown): boolean => {
  ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = yaacWindow
  const room = render(<YTrafficLights />).container.firstChild !== null
  cleanup()
  return room
}

afterEach(() => { delete (window as unknown as { yaacWindow?: unknown }).yaacWindow })

describe('YTrafficLights', () => {
  it('leaves room on a Mac only in the desktop app\'s own window', () => {
    expect(leavesRoom(bridge('desktop'))).toBe(true)
    // A preview pane is Electron on a Mac too, but gets no bridge.
    expect(leavesRoom()).toBe(false)
    // The iPhone app's bridge (iPadOS also reports a Mac).
    expect(leavesRoom(bridge('ios'))).toBe(false)
  })
})
