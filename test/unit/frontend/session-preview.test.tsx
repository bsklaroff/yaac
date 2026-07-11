// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SessionPreview } from '@/frontend/components/SessionPreview'

const realUA = navigator.userAgent
function setElectron(on: boolean): void {
  Object.defineProperty(navigator, 'userAgent', {
    value: on ? `${realUA} Electron/43` : realUA,
    configurable: true,
  })
}

afterEach(() => {
  cleanup()
  setElectron(false)
  delete (window as unknown as { yaacWindow?: unknown }).yaacWindow
})

describe('SessionPreview (browser build)', () => {
  it('shows a fallback link to the forwarded port when not in Electron', () => {
    setElectron(false)
    render(<SessionPreview sessionId="s1" containerPort={5173} hostPort={15173} />)
    const link = screen.getByRole('link', { name: /localhost:15173/ })
    expect(link.getAttribute('href')).toBe('http://localhost:15173/')
  })
})

describe('SessionPreview (Electron)', () => {
  it('creates a partitioned webview and shows the address', () => {
    setElectron(true)
    const { container } = render(
      <SessionPreview sessionId="abc" containerPort={5173} hostPort={15173} />,
    )
    const wv = container.querySelector('webview')
    expect(wv).not.toBeNull()
    expect(wv?.getAttribute('partition')).toBe('persist:preview-abc')
    expect(wv?.getAttribute('src')).toBe('http://localhost:15173/')
    const input = screen.getByLabelText('Preview address') as HTMLInputElement
    expect(input.value).toBe('http://localhost:15173/')
  })

  it('shows a waiting state until the port is forwarded', () => {
    setElectron(true)
    render(<SessionPreview sessionId="abc" containerPort={5173} hostPort={undefined} />)
    expect(screen.getByText(/Waiting for the dev server on port 5173/)).toBeTruthy()
  })

  it('opens the current address in the system browser', () => {
    setElectron(true)
    const openExternal = vi.fn()
    ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = {
      minimize() {}, toggleMaximize() {}, close() {}, openExternal,
    }
    render(<SessionPreview sessionId="abc" containerPort={5173} hostPort={15173} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(openExternal).toHaveBeenCalledWith('http://localhost:15173/')
  })
})
