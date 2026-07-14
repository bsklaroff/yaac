// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionChanges as SessionChangesData } from '@yaac/shared/types'

vi.mock('#lib/changesApi', () => ({ getSessionChanges: vi.fn() }))
import { getSessionChanges } from '#lib/changesApi'
import { SessionChanges } from '#components/SessionChanges'

const mock = vi.mocked(getSessionChanges)

const PAYLOAD: SessionChangesData = {
  base: 'abc123',
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
    { path: 'new.ts', status: 'added', additions: 2, deletions: 0, binary: false },
  ],
  diff: [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-old',
    '+new1',
    '+new2',
    'diff --git a/new.ts b/new.ts',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+alpha',
    '+beta',
  ].join('\n'),
  truncated: false,
}

function renderPane(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SessionChanges sessionId="s1" />
    </QueryClientProvider>,
  )
}

afterEach(() => { cleanup(); mock.mockReset() })

describe('SessionChanges', () => {
  it('lists changed files and auto-expands the first file’s diff', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByText('2 files')).toBeTruthy())
    expect(screen.getByText('new1')).toBeTruthy() // first file expanded by default
    // The second file is collapsed until clicked.
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('expands a file’s diff inline when its row is clicked, and collapses it again', async () => {
    mock.mockResolvedValue(PAYLOAD)
    renderPane()
    await waitFor(() => expect(screen.getByTitle('new.ts')).toBeTruthy())
    fireEvent.click(screen.getByTitle('new.ts'))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('new1')).toBeTruthy() // first file stays open (multiple can be)

    fireEvent.click(screen.getByTitle('src/app.ts'))
    expect(screen.queryByText('new1')).toBeNull() // collapsed
  })

  it('shows an empty state when nothing changed', async () => {
    mock.mockResolvedValue({ base: 'abc', files: [], diff: '', truncated: false })
    renderPane()
    await waitFor(() => expect(screen.getByText('No changes yet')).toBeTruthy())
  })

  it('warns when the diff was truncated', async () => {
    mock.mockResolvedValue({ ...PAYLOAD, truncated: true })
    renderPane()
    await waitFor(() => expect(screen.getByText(/truncated/)).toBeTruthy())
  })
})
