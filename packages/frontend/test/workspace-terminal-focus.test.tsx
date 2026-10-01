// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { WorkspaceTerminal } from '#components/WorkspaceTerminal'

/**
 * Where a terminal pane's focus goes when it is the pane to focus. jsdom
 * lacks what xterm and the attach loop reach for on mount, so those are
 * stubbed; the socket never opens, which focus does not depend on.
 */
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} }
  window.matchMedia ??= (() => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })) as never
  globalThis.WebSocket = class { send(): void {} close(): void {} addEventListener(): void {} } as never
})

function xtermInput(): Element | null {
  return document.querySelector('textarea[aria-label="Terminal input"]')
}

describe('WorkspaceTerminal focus', () => {
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  it('focuses the terminal when it is the pane to focus', () => {
    render(<WorkspaceTerminal workspaceId="w1" focusKey={1} />)
    expect(document.activeElement).toBe(xtermInput())
  })

  /** A tui workspace finishing its start-up under the new-workspace dialog. */
  it('leaves focus in an open dialog', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const prompt = document.createElement('textarea')
    dialog.append(prompt)
    document.body.append(dialog)
    prompt.focus()

    const { rerender } = render(<WorkspaceTerminal workspaceId="w1" focusKey={1} />)
    rerender(<WorkspaceTerminal workspaceId="w1" focusKey={2} />)
    expect(document.activeElement).toBe(prompt)
  })
})
