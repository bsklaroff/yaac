// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { WorkspacePreview } from '#components/WorkspacePreview'
import type { PortMapping } from '@yaac/shared/types'

const fwd = (containerPort: number, hostPort: number): PortMapping => ({
  containerPort, hostPort,
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { yaacWindow?: unknown }).yaacWindow
})

describe('WorkspacePreview', () => {
  it('creates a partitioned webview and shows the address', () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" ports={[fwd(5173, 15173)]} currentPort={5173} onSwitchPort={() => {}} />,
    )
    const wv = container.querySelector('webview')
    expect(wv).not.toBeNull()
    expect(wv?.getAttribute('partition')).toBe('persist:preview-abc')
    expect(wv?.getAttribute('src')).toBe('http://127.0.0.1:15173/')
    const input = screen.getByLabelText<HTMLInputElement>('Preview address')
    expect(input.value).toBe('http://127.0.0.1:15173/')
  })

  it('shows a waiting state until the port is forwarded', () => {
    render(<WorkspacePreview workspaceId="abc" ports={[]} currentPort={undefined} onSwitchPort={() => {}} />)
    expect(screen.getByText(/Waiting for the dev server/)).toBeTruthy()
  })

  it('opens the current address in the system browser', () => {
    const openExternal = vi.fn()
    ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = {
      minimize() {}, toggleMaximize() {}, close() {}, openExternal,
    }
    render(<WorkspacePreview workspaceId="abc" ports={[fwd(5173, 15173)]} currentPort={5173} onSwitchPort={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:15173/')
  })

  it('offers a port dropdown when several ports are forwarded', () => {
    const onSwitchPort = vi.fn()
    render(
      <WorkspacePreview
        workspaceId="abc"
        ports={[fwd(5173, 15173), fwd(8080, 18080)]}
        currentPort={5173}
        onSwitchPort={onSwitchPort}
      />,
    )
    const select = screen.getByLabelText<HTMLSelectElement>('Preview port')
    expect(select.value).toBe('5173')
    fireEvent.change(select, { target: { value: '8080' } })
    expect(onSwitchPort).toHaveBeenCalledWith(8080)
  })

  it('shows no dropdown for a single port', () => {
    render(<WorkspacePreview workspaceId="abc" ports={[fwd(5173, 15173)]} currentPort={5173} onSwitchPort={() => {}} />)
    expect(screen.queryByLabelText('Preview port')).toBeNull()
  })

  it('has an overflow menu whose actions drive the webview', async () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" ports={[fwd(5173, 15173)]} currentPort={5173} onSwitchPort={() => {}} />,
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

  it('constrains the webview to a device width, with a clearable pill', async () => {
    const { container } = render(
      <WorkspacePreview workspaceId="abc" ports={[fwd(5173, 15173)]} currentPort={5173} onSwitchPort={() => {}} />,
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
