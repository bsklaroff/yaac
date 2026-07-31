// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('#lib/createSession', () => ({
  renameSession: vi.fn(),
  setSessionBackground: vi.fn(),
  restartSession: vi.fn(),
  dismissProvisioning: vi.fn(),
}))

import { SessionRow } from '#components/Sidebar'
import { renameSession } from '#lib/createSession'
import { useUiStore } from '#store'
import type { SessionListEntry } from '@yaac/shared/types'

const session = (extra: Partial<SessionListEntry> = {}): SessionListEntry => ({
  sessionId: 's1', projectSlug: 'p', tool: 'claude', status: 'waiting',
  createdAt: '2026-01-01 00:00:00', blockedHosts: [], forwardedPorts: [], ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(renameSession).mockResolvedValue(undefined)
  useUiStore.setState({ selectedSessionId: null })
})

afterEach(cleanup)

/** Click the row's rename pencil to open the inline editor and return the field. */
function openEditor(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Session title' })
}

describe('SessionRow rename', () => {
  it('seeds the editor from the title, falling back to the prompt', () => {
    render(<SessionRow session={session({ title: 'My session', prompt: 'do a thing' })} />)
    expect(openEditor().value).toBe('My session')
    cleanup()

    render(<SessionRow session={session({ title: '', prompt: 'do a thing' })} />)
    expect(openEditor().value).toBe('do a thing')
  })

  it('commits a rename on Enter and closes the editor', () => {
    render(<SessionRow session={session({ title: 'Old' })} />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameSession).toHaveBeenCalledWith('s1', 'New name')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('commits a rename on blur', () => {
    render(<SessionRow session={session({ title: 'Old' })} />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)

    expect(renameSession).toHaveBeenCalledWith('s1', 'Renamed')
  })

  it('reverts on Escape without renaming', () => {
    render(<SessionRow session={session({ title: 'Old' })} />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'discard me' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(renameSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not rename when the value is unchanged', () => {
    render(<SessionRow session={session({ title: 'Same' })} />)
    const input = openEditor()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameSession).not.toHaveBeenCalled()
  })

  it('does not select the session when clicking the rename pencil', () => {
    render(<SessionRow session={session({ title: 'Old' })} />)
    openEditor()

    expect(useUiStore.getState().selectedSessionId).toBeNull()
  })
})
