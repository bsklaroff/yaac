import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JSX } from 'react'
import { cleanup, render } from '@testing-library/react'
import { YDialog, YTrafficLights } from '#ui'

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

describe('YDialog', () => {
  it('hides the traffic lights while a dialog reaching the corner is open', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'setTimeout'] })
    const setWindowButtonsVisible = vi.fn()
    ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = { ...(bridge('desktop') as object), setWindowButtonsVisible }
    const dialog = (variant: 'sheet' | 'split' | 'form', open: boolean): JSX.Element => (
      <YDialog open={open} onOpenChange={() => {}} variant={variant}>body</YDialog>
    )
    const { rerender, unmount } = render(<>{dialog('sheet', true)}{dialog('split', true)}</>)
    // Not until the dialog has painted.
    expect(setWindowButtonsVisible).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(setWindowButtonsVisible.mock.calls).toEqual([[false]])
    // They come back only once the last covering dialog closes.
    rerender(<>{dialog('sheet', false)}{dialog('split', true)}</>)
    expect(setWindowButtonsVisible.mock.calls).toEqual([[false]])
    rerender(<>{dialog('sheet', false)}{dialog('split', false)}</>)
    expect(setWindowButtonsVisible.mock.calls).toEqual([[false], [true]])
    // A centred dialog clears them.
    rerender(<>{dialog('form', true)}</>)
    vi.runAllTimers()
    expect(setWindowButtonsVisible.mock.calls).toHaveLength(2)
    unmount()
    vi.useRealTimers()
  })
})
