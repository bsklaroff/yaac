// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, createEvent } from '@testing-library/react'

vi.mock('#lib/createWorkspace', () => ({
  renameWorkspace: vi.fn(),
}))

import { WorkspaceTitle, oneLine } from '#components/WorkspaceTitle'
import { renameWorkspace } from '#lib/createWorkspace'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(renameWorkspace).mockResolvedValue(undefined)
})

afterEach(cleanup)

/** Click the pencil to open the inline editor and return the field. */
function openEditor(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: 'Rename workspace' }))
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Workspace title' })
}

describe('oneLine', () => {
  it('collapses internal whitespace runs, including newlines, to a single space', () => {
    expect(oneLine('do a\n   thing')).toBe('do a thing')
  })

  it('trims leading and trailing whitespace', () => {
    expect(oneLine('  padded  ')).toBe('padded')
  })

  it('leaves an already-single-line string unchanged', () => {
    expect(oneLine('My title')).toBe('My title')
  })

  it('collapses an all-whitespace string to empty', () => {
    expect(oneLine('   \n\t  ')).toBe('')
  })
})

describe('WorkspaceTitle', () => {
  it('shows the title as selectable text with a rename affordance', () => {
    render(<WorkspaceTitle workspaceId="s1" title="My workspace" prompt="do a thing" />)
    const label = screen.getByText('My workspace')
    // Selectable for copy/paste (opts out of the Electron drag region).
    expect(label.className).toContain('select-text')
    expect(screen.getByRole('button', { name: 'Rename workspace' })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('falls back to the prompt when there is no title', () => {
    render(<WorkspaceTitle workspaceId="s1" title="" prompt="my first prompt" />)
    expect(screen.getByText('my first prompt')).toBeTruthy()
  })

  it('opens the editor pre-filled with the existing title, cursor at the end', () => {
    render(<WorkspaceTitle workspaceId="s1" title="Existing name" prompt="p" />)
    const input = openEditor()
    expect(input.value).toBe('Existing name')
    // Cursor at the end, not select-all, which the first keystroke would clear.
    expect(input.selectionStart).toBe('Existing name'.length)
    expect(input.selectionEnd).toBe('Existing name'.length)
  })

  it('seeds the editor from the prompt when the workspace has no title', () => {
    render(<WorkspaceTitle workspaceId="s1" title="" prompt="do the thing" />)
    expect(openEditor().value).toBe('do the thing')
  })

  it('copies the title without the flex-item block boundary newlines', () => {
    render(<WorkspaceTitle workspaceId="s1" title="My title" prompt="p" />)
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
    render(<WorkspaceTitle workspaceId="s1" title="Old" prompt="p" />)
    const input = openEditor()
    expect(input.value).toBe('Old')
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameWorkspace).toHaveBeenCalledWith('s1', 'New name')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('commits a rename on blur', () => {
    render(<WorkspaceTitle workspaceId="s1" title="Old" prompt="p" />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)

    expect(renameWorkspace).toHaveBeenCalledWith('s1', 'Renamed')
  })

  it('reverts on Escape without renaming', () => {
    render(<WorkspaceTitle workspaceId="s1" title="Old" prompt="p" />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'discard me' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(renameWorkspace).not.toHaveBeenCalled()
    expect(screen.getByText('Old')).toBeTruthy()
  })

  it('does not rename when the value is unchanged', () => {
    render(<WorkspaceTitle workspaceId="s1" title="Same" prompt="p" />)
    const input = openEditor()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameWorkspace).not.toHaveBeenCalled()
  })

  it('does not persist the prompt fallback when an untitled workspace is committed unchanged', () => {
    // The header shows the prompt while a generated title is pending. Pressing
    // Enter with no change must not write a title row, which would block the
    // generated title for good.
    render(<WorkspaceTitle workspaceId="s1" title="" prompt="my first message" />)
    const input = openEditor()
    expect(input.value).toBe('my first message')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameWorkspace).not.toHaveBeenCalled()
  })

  it('collapses a multi-line prompt fallback to one line and treats it as unchanged', () => {
    render(<WorkspaceTitle workspaceId="s1" title="" prompt={'do a\n   thing'} />)
    const input = openEditor()
    // Opens as a single, collapsed line (an <input> can't hold the newline)...
    expect(input.value).toBe('do a thing')
    // ...and committing that untouched value saves nothing.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()
  })

  it('trims surrounding whitespace before comparing and committing', () => {
    render(<WorkspaceTitle workspaceId="s1" title="Kept" prompt="p" />)
    const input = openEditor()
    // Same title with padding is a no-op.
    fireEvent.change(input, { target: { value: '  Kept  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()

    // A real change is trimmed on the way out.
    const input2 = openEditor()
    fireEvent.change(input2, { target: { value: '  Fresh  ' } })
    fireEvent.keyDown(input2, { key: 'Enter' })
    expect(renameWorkspace).toHaveBeenCalledWith('s1', 'Fresh')
  })
})
