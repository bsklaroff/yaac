// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ServerBadge, ServersButton, serverLabel } from '#components/ServerBadge'

const inject = (bridge: unknown): void => {
  ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = bridge
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { yaacWindow?: unknown }).yaacWindow
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
  it('renders nothing outside the desktop shell, or in an app without the Servers page', () => {
    expect(render(<ServerBadge />).container.innerHTML).toBe('')
    inject({ close() {} })
    expect(render(<ServerBadge />).container.innerHTML).toBe('')
  })

  it('names the attached origin and opens the shell\'s Servers page', () => {
    const showServers = vi.fn()
    inject({ showServers })
    render(<ServerBadge />)
    const chit = screen.getByRole('button', { name: 'Choose a server' })
    expect(chit.textContent).toBe(serverLabel(window.location.origin))
    expect(chit.title).toContain(window.location.origin)

    fireEvent.click(chit)
    expect(showServers).toHaveBeenCalledOnce()
  })
})

describe('ServersButton', () => {
  it('opens the shell\'s Servers page, and renders nothing without it', () => {
    expect(render(<ServersButton />).container.innerHTML).toBe('')
    const showServers = vi.fn()
    inject({ showServers })
    render(<ServersButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Servers' }))
    expect(showServers).toHaveBeenCalledOnce()
  })

  it('as the phone layout\'s row, also names the server', () => {
    const showServers = vi.fn()
    inject({ showServers })
    render(<ServersButton variant="row" />)
    const row = screen.getByRole('button', { name: 'Servers' })
    expect(row.textContent).toBe(`Servers${serverLabel(window.location.origin)}`)
    fireEvent.click(row)
    expect(showServers).toHaveBeenCalledOnce()
  })
})
