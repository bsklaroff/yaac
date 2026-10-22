import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import type { JSX } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { WorkspacePreview } from '#components/WorkspacePreview'
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  delete (window as unknown as { yaacWindow?: unknown }).yaacWindow
})

describe('WorkspacePreview', () => {
  it('creates a partitioned webview and shows the address', () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" visible containerPort={5173} hostPort={15173} />,
    )
    const wv = container.querySelector('webview')
    expect(wv).not.toBeNull()
    expect(wv?.getAttribute('partition')).toBe('persist:preview-abc')
    expect(wv?.getAttribute('src')).toBe('http://127.0.0.1:15173/')
    const input = screen.getByLabelText<HTMLInputElement>('Preview address')
    expect(input.value).toBe('http://127.0.0.1:15173/')
  })

  it('shows a waiting state while its port is not forwarded, with nothing to stop', async () => {
    render(<WorkspacePreview workspaceId="abc" visible containerPort={5173} hostPort={undefined} onStopForwarding={() => {}} />)
    expect(screen.getByText('Waiting for the dev server on :5173…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Preview menu' }))
    await screen.findByText('Home')
    expect(screen.queryByText(/Stop forwarding/)).toBeNull()
  })

  it('opens the current address in the system browser', () => {
    const openExternal = vi.fn()
    ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = {
      minimize() {}, toggleMaximize() {}, close() {}, openExternal,
    }
    render(<WorkspacePreview workspaceId="abc" visible containerPort={5173} hostPort={15173} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:15173/')
  })

  it('has an overflow menu whose actions drive the webview', async () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" visible containerPort={5173} hostPort={15173} />,
    )
    const wv = container.querySelector('webview')
    const openDevTools = vi.fn()
    const loadURL = vi.fn()
    Object.assign(wv as object, { openDevTools, loadURL })

    fireEvent.click(screen.getByRole('button', { name: 'Preview menu' }))
    fireEvent.click(await screen.findByText('Open DevTools'))
    expect(openDevTools).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Preview menu' }))
    fireEvent.click(await screen.findByText('Home'))
    expect(loadURL).toHaveBeenCalledWith('http://127.0.0.1:15173/')
  })

  it('stops forwarding the port it shows', async () => {
    const onStopForwarding = vi.fn()
    render(<WorkspacePreview workspaceId="abc" visible containerPort={5173} hostPort={15173} onStopForwarding={onStopForwarding} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview menu' }))
    fireEvent.click(await screen.findByText('Stop forwarding :5173'))
    expect(onStopForwarding).toHaveBeenCalledWith(5173)
  })

  it('constrains the webview to a device width, with a clearable pill', async () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" visible containerPort={5173} hostPort={15173} />,
    )
    const host = container.querySelector('webview')?.parentElement as HTMLElement
    expect(host.style.width).toBe('100%')

    fireEvent.click(screen.getByRole('button', { name: 'Preview menu' }))
    fireEvent.click(await screen.findByText(/Mobile/))
    expect(host.style.width).toBe('375px')

    const pill = screen.getByRole('button', { name: 'Reset width' })
    fireEvent.click(pill)
    expect(host.style.width).toBe('100%')
    expect(screen.queryByRole('button', { name: 'Reset width' })).toBeNull()
  })

  describe('while hidden', () => {
    const MIN = 60_000
    let bridge: {
      setPreviewFrozen: Mock<(id: number, frozen: boolean) => Promise<boolean>>
      canDiscardPreview: Mock<(id: number) => Promise<boolean>>
      onMemoryPressure: Mock<(cb: () => void) => () => void>
    }
    let pressure: (() => void) | undefined
    let nextId = 1
    // Stub what Electron's guest answers on the current webview.
    const attach = (container: HTMLElement, url: string): Element => {
      const wv = container.querySelector('webview') as Element
      const id = nextId++
      Object.assign(wv, { getWebContentsId: () => id, getURL: () => url })
      return wv
    }
    const preview = (visible: boolean): JSX.Element =>
      <WorkspacePreview workspaceId="abc" containerPort={5173} hostPort={15173} visible={visible} />
    const advance = (ms: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

    beforeEach(() => {
      vi.useFakeTimers()
      pressure = undefined
      bridge = {
        setPreviewFrozen: vi.fn(() => Promise.resolve(true)),
        canDiscardPreview: vi.fn(() => Promise.resolve(true)),
        onMemoryPressure: vi.fn((cb) => {
          pressure = cb
          return () => { pressure = undefined }
        }),
      }
      ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = { openExternal() {}, showServers() {}, ...bridge }
    })

    it('freezes the page, thaws it when shown, and discards it to reload at its URL', async () => {
      const { container, rerender } = render(preview(true))
      const first = attach(container, 'http://127.0.0.1:15173/settings')

      rerender(preview(false))
      await advance(5 * MIN - 1)
      expect(bridge.setPreviewFrozen).not.toHaveBeenCalled()
      await advance(1)
      expect(bridge.setPreviewFrozen).toHaveBeenLastCalledWith(1, true)
      rerender(preview(true))
      expect(bridge.setPreviewFrozen).toHaveBeenLastCalledWith(1, false)

      // Hidden for four hours: the webview goes, and showing the pane brings
      // a new one back on the page the old one was on.
      rerender(preview(false))
      await advance(4 * 60 * MIN)
      expect(bridge.canDiscardPreview).toHaveBeenCalledWith(1)
      expect(container.querySelector('webview')).toBeNull()
      rerender(preview(true))
      const second = container.querySelector('webview')
      expect(second).not.toBe(first)
      expect(second?.getAttribute('src')).toBe('http://127.0.0.1:15173/settings')
      expect(bridge.setPreviewFrozen).toHaveBeenCalledTimes(3)
    })

    it('keeps a page the app says to keep, and one revisited more than 15 times', async () => {
      const { container, rerender } = render(preview(true))
      const wv = attach(container, 'http://127.0.0.1:15173/')
      bridge.canDiscardPreview.mockResolvedValueOnce(false)
      rerender(preview(false))
      await advance(4 * 60 * MIN)
      expect(container.querySelector('webview')).toBe(wv)

      for (let i = 0; i < 16; i++) {
        rerender(preview(true))
        rerender(preview(false))
      }
      bridge.canDiscardPreview.mockClear()
      await advance(4 * 60 * MIN)
      expect(bridge.canDiscardPreview).not.toHaveBeenCalled()
      expect(container.querySelector('webview')).toBe(wv)
    })

    it('under memory pressure, discards the longest-hidden preview that may go, one per signal', async () => {
      const panes = (shown: number[]): JSX.Element => <>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} data-pane={i}>
            <WorkspacePreview workspaceId="abc" containerPort={5173 + i} hostPort={15173 + i} visible={shown.includes(i)} />
          </div>
        ))}
      </>
      const { container, rerender } = render(panes([0, 1, 2, 3]))
      const webviews = [0, 1, 2, 3].map((i) => {
        const pane = container.querySelector(`[data-pane="${i}"]`) as HTMLElement
        return attach(pane, `http://127.0.0.1:${15173 + i}/page`)
      })
      const alive = (i: number): boolean => container.contains(webviews[i])
      expect(bridge.onMemoryPressure).not.toHaveBeenCalled()

      // 0 hidden first, then 1, then 2 (which the app says to keep); 3 is
      // hidden too recently to go.
      rerender(panes([1, 2, 3]))
      expect(pressure).toBeDefined()
      await advance(MIN)
      rerender(panes([2, 3]))
      await advance(MIN)
      rerender(panes([3]))
      await advance(10 * MIN)
      rerender(panes([]))
      const kept = (webviews[2] as unknown as { getWebContentsId: () => number }).getWebContentsId()
      bridge.canDiscardPreview.mockImplementation((id) => Promise.resolve(id !== kept))
      const signal = (): Promise<void> => act(async () => {
        pressure?.()
        await vi.advanceTimersByTimeAsync(0)
      })

      await signal()
      expect([0, 1, 2, 3].map(alive)).toEqual([false, true, true, true])
      await signal()
      expect([0, 1, 2, 3].map(alive)).toEqual([false, false, true, true])
      await signal()
      expect([0, 1, 2, 3].map(alive)).toEqual([false, false, true, true])

      // Shown, a discarded pane reloads where it was; the desktop app stops
      // watching once no preview is hidden.
      rerender(panes([0, 1, 2, 3]))
      const pane0 = container.querySelector('[data-pane="0"] webview')
      expect(pane0?.getAttribute('src')).toBe('http://127.0.0.1:15173/page')
      expect(pressure).toBeUndefined()
    })
  })
})
