// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, createEvent } from '@testing-library/react'

vi.mock('#lib/createSession', () => ({
  renameSession: vi.fn(),
}))

import { SessionTitle } from '#components/SessionTitle'
import { renameSession } from '#lib/createSession'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(renameSession).mockResolvedValue(undefined)
})

afterEach(cleanup)

/** Click the pencil to open the inline editor and return the field. */
function openEditor(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Session title' })
}

describe('SessionTitle', () => {
  it('shows the title as selectable text with a rename affordance', () => {
    render(<SessionTitle worktreeId="s1" title="My session" prompt="do a thing" />)
    const label = screen.getByText('My session')
    // Selectable for copy/paste (opts out of the Electron drag region).
    expect(label.className).toContain('select-text')
    expect(screen.getByRole('button', { name: 'Rename session' })).toBeTruthy()
    // Not editing yet: no input on screen.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('falls back to the prompt when there is no title', () => {
    render(<SessionTitle worktreeId="s1" title="" prompt="my first prompt" />)
    expect(screen.getByText('my first prompt')).toBeTruthy()
  })

  it('opens the editor pre-filled with the existing title, cursor at the end', () => {
    render(<SessionTitle worktreeId="s1" title="Existing name" prompt="p" />)
    const input = openEditor()
    expect(input.value).toBe('Existing name')
    // Cursor at the end (not a full select-all, which would clear on the first
    // keystroke) — so the existing title stays editable.
    expect(input.selectionStart).toBe('Existing name'.length)
    expect(input.selectionEnd).toBe('Existing name'.length)
  })

  it('seeds the editor from the prompt when the session has no title', () => {
    render(<SessionTitle worktreeId="s1" title="" prompt="do the thing" />)
    expect(openEditor().value).toBe('do the thing')
  })

  it('copies the title without the flex-item block boundary newlines', () => {
    render(<SessionTitle worktreeId="s1" title="My title" prompt="p" />)
    const label = screen.getByText('My title')
    const getSelection = vi.spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => '\nMy title\n' } as unknown as Selection)
    const setData = vi.fn()
    const event = createEvent.copy(label, { clipboardData: { setData } })

    fireEvent(label, event)

    expect(setData).toHaveBeenCalledWith('text/plain', 'My title')
    expect(event.defaultPrevented).toBe(true)
    getSelection.mockRestore()
  })

  it('commits a rename on Enter', () => {
    render(<SessionTitle worktreeId="s1" title="Old" prompt="p" />)
    const input = openEditor()
    expect(input.value).toBe('Old')
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameSession).toHaveBeenCalledWith('s1', 'New name')
    // Editor closes back to the label.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('commits a rename on blur', () => {
    render(<SessionTitle worktreeId="s1" title="Old" prompt="p" />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)

    expect(renameSession).toHaveBeenCalledWith('s1', 'Renamed')
  })

  it('reverts on Escape without renaming', () => {
    render(<SessionTitle worktreeId="s1" title="Old" prompt="p" />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'discard me' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(renameSession).not.toHaveBeenCalled()
    expect(screen.getByText('Old')).toBeTruthy()
  })

  it('does not rename when the value is unchanged', () => {
    render(<SessionTitle worktreeId="s1" title="Same" prompt="p" />)
    const input = openEditor()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameSession).not.toHaveBeenCalled()
  })

  it('does not persist the prompt fallback when an untitled session is committed unchanged', () => {
    // The header shows the prompt while a model title is still pending; edit →
    // Enter with no change must not write a title row (which would permanently
    // block the auto-generated title).
    render(<SessionTitle worktreeId="s1" title="" prompt="my first message" />)
    const input = openEditor()
    expect(input.value).toBe('my first message')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameSession).not.toHaveBeenCalled()
  })

  it('collapses a multi-line prompt fallback to one line and treats it as unchanged', () => {
    render(<SessionTitle worktreeId="s1" title="" prompt={'do a\n   thing'} />)
    const input = openEditor()
    // Opens as a single, collapsed line (an <input> can't hold the newline)...
    expect(input.value).toBe('do a thing')
    // ...and committing that untouched value saves nothing.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).not.toHaveBeenCalled()
  })

  it('trims surrounding whitespace before comparing and committing', () => {
    render(<SessionTitle worktreeId="s1" title="Kept" prompt="p" />)
    const input = openEditor()
    // Same title with padding — should be treated as a no-op.
    fireEvent.change(input, { target: { value: '  Kept  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).not.toHaveBeenCalled()

    // A real change is trimmed on the way out.
    const input2 = openEditor()
    fireEvent.change(input2, { target: { value: '  Fresh  ' } })
    fireEvent.keyDown(input2, { key: 'Enter' })
    expect(renameSession).toHaveBeenCalledWith('s1', 'Fresh')
  })
})
