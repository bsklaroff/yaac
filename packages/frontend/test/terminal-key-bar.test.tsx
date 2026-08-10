// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalKeyBar } from '#components/TerminalKeyBar'
import { PTY_KEYS, paneKey, registerPtyInput } from '#lib/ptyInput'

afterEach(cleanup)

describe('TerminalKeyBar', () => {
  it('types the keys a soft keyboard doesn’t have into the pane', () => {
    const send = vi.fn()
    const off = registerPtyInput(paneKey('s1', 'agent'), send)
    render(<TerminalKeyBar worktreeId="s1" target="agent" />)

    fireEvent.pointerDown(screen.getByLabelText('Escape'))
    expect(send).toHaveBeenLastCalledWith(PTY_KEYS.escape)

    fireEvent.pointerDown(screen.getByLabelText('Tab'))
    expect(send).toHaveBeenLastCalledWith(PTY_KEYS.tab)

    fireEvent.pointerDown(screen.getByLabelText('Control C'))
    expect(send).toHaveBeenLastCalledWith(PTY_KEYS.ctrlC)

    fireEvent.pointerDown(screen.getByLabelText('Up arrow'))
    expect(send).toHaveBeenLastCalledWith(PTY_KEYS.up)
    off()
  })

  it('presses without taking focus, so the soft keyboard stays up', () => {
    const off = registerPtyInput(paneKey('s1', 'agent'), vi.fn())
    render(<TerminalKeyBar worktreeId="s1" target="agent" />)
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    screen.getByLabelText('Escape').dispatchEvent(event)
    // The default action — moving focus out of xterm's hidden textarea, which
    // dismisses the keyboard — is what must not happen.
    expect(event.defaultPrevented).toBe(true)
    off()
  })

  it('is harmless when its pane has gone away mid-press', () => {
    render(<TerminalKeyBar worktreeId="ghost" target="agent" />)
    expect(() => fireEvent.pointerDown(screen.getByLabelText('Escape'))).not.toThrow()
  })
})
