import { describe, it, expect, vi } from 'vitest'
import { WorkspaceTerminal } from '#components/WorkspaceTerminal'
import { MOBILE_QUERY } from '#lib/viewport'
import { renderWithClient } from './harness'

/**
 * Where a terminal pane's focus goes when it is the pane to focus. The
 * socket connects a tick after mount, so these synchronous cases never open
 * one; focus does not depend on it.
 */

function xtermInput(): Element | null {
  return document.querySelector('textarea[aria-label="Terminal input"]')
}

describe('WorkspaceTerminal focus', () => {
  it('focuses the terminal when it is the pane to focus', () => {
    renderWithClient(<WorkspaceTerminal workspaceId="w1" target="agent" visible focusKey={1} />)
    expect(document.activeElement).toBe(xtermInput())
  })

  it('leaves the terminal unfocused on a phone, where focus raises the keyboard', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === MOBILE_QUERY, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }))
    renderWithClient(<WorkspaceTerminal workspaceId="w1" target="agent" visible focusKey={1} />)
    expect(xtermInput()).toBeTruthy()
    expect(document.activeElement).not.toBe(xtermInput())
  })

  /** A tui workspace finishing its start-up under the new-workspace dialog. */
  it('leaves focus in an open dialog', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const prompt = document.createElement('textarea')
    dialog.append(prompt)
    document.body.append(dialog)
    prompt.focus()

    renderWithClient(<WorkspaceTerminal workspaceId="w1" target="agent" visible focusKey={1} />)
    expect(document.activeElement).toBe(prompt)
    dialog.remove()
  })
})
