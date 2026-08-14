// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ServerBadge, serverLabel } from '#components/ServerBadge'
import { useUiStore } from '#store'

const inject = (bridge: unknown): void => {
  ;(window as unknown as { yaacServer?: unknown }).yaacServer = bridge
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { yaacServer?: unknown }).yaacServer
  useUiStore.setState({ settingsOpen: false, settingsSection: 'general' })
})

describe('serverLabel', () => {
  it('drops the scheme and keeps the port', () => {
    expect(serverLabel('http://localhost:4200')).toBe('localhost:4200')
    expect(serverLabel('https://host.tail1234.ts.net')).toBe('host.tail1234.ts.net')
  })

  it('shows an unparseable origin verbatim', () => {
    expect(serverLabel('not a url')).toBe('not a url')
  })
})

describe('ServerBadge', () => {
  it('renders nothing without the desktop bridge', () => {
    const { container } = render(<ServerBadge />)
    expect(container.innerHTML).toBe('')
  })

  it('names the attached origin and opens server settings', () => {
    inject({ targets() {}, switchTo() {}, addRemote() {} })
    render(<ServerBadge />)
    const chit = screen.getByRole('button', { name: 'Open server settings' })
    expect(chit.textContent).toBe(serverLabel(window.location.origin))
    expect(chit.title).toContain(window.location.origin)

    fireEvent.click(chit)
    expect(useUiStore.getState().settingsOpen).toBe(true)
    expect(useUiStore.getState().settingsSection).toBe('server')
  })
})
