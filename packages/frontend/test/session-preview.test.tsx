import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { WorkspacePreview } from '#components/WorkspacePreview'
afterEach(() => {
  cleanup()
  delete (window as unknown as { yaacWindow?: unknown }).yaacWindow
})

describe('WorkspacePreview', () => {
  it('creates a partitioned webview and shows the address', () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" containerPort={5173} hostPort={15173} />,
    )
    const wv = container.querySelector('webview')
    expect(wv).not.toBeNull()
    expect(wv?.getAttribute('partition')).toBe('persist:preview-abc')
    expect(wv?.getAttribute('src')).toBe('http://127.0.0.1:15173/')
    const input = screen.getByLabelText<HTMLInputElement>('Preview address')
    expect(input.value).toBe('http://127.0.0.1:15173/')
  })

  it('shows a waiting state while its port is not forwarded, with nothing to stop', async () => {
    render(<WorkspacePreview workspaceId="abc" containerPort={5173} hostPort={undefined} onStopForwarding={() => {}} />)
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
    render(<WorkspacePreview workspaceId="abc" containerPort={5173} hostPort={15173} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:15173/')
  })

  it('has an overflow menu whose actions drive the webview', async () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" containerPort={5173} hostPort={15173} />,
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
    render(<WorkspacePreview workspaceId="abc" containerPort={5173} hostPort={15173} onStopForwarding={onStopForwarding} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview menu' }))
    fireEvent.click(await screen.findByText('Stop forwarding :5173'))
    expect(onStopForwarding).toHaveBeenCalledWith(5173)
  })

  it('constrains the webview to a device width, with a clearable pill', async () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" containerPort={5173} hostPort={15173} />,
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
})
