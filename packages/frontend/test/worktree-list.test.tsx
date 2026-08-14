// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type {
  ProvisioningWorktreeEntry,
  StoppedWorktreeEntry,
  WorktreeGroupSummary,
  WorktreeListEntry,
} from '@yaac/shared/types'

const stoppedRows: StoppedWorktreeEntry[] = []
vi.mock('#lib/stoppedApi', () => ({ getStoppedWorktrees: vi.fn(() => Promise.resolve(stoppedRows)) }))
vi.mock('#lib/createWorktree', () => ({
  dismissProvisioning: vi.fn(),
  restartWorktree: vi.fn(),
  renameWorktree: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/groupApi', () => ({
  createWorktreeGroup: vi.fn(() => Promise.resolve({ groupId: 'g-new' })),
  renameWorktreeGroup: vi.fn(() => Promise.resolve()),
  setWorktreeGroupPinned: vi.fn(() => Promise.resolve()),
  deleteWorktreeGroup: vi.fn(() => Promise.resolve()),
  setWorktreeGroup: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/stopWorktreeFlow', () => ({ stopWorktreeOptimistic: vi.fn() }))
vi.mock('#lib/useProvisionWorktree', () => ({ useProvisionWorktree: () => vi.fn() }))

import { WorktreeList } from '#components/WorktreeList'
import { renameWorktree } from '#lib/createWorktree'
import {
  createWorktreeGroup,
  deleteWorktreeGroup,
  renameWorktreeGroup,
  setWorktreeGroup,
  setWorktreeGroupPinned,
} from '#lib/groupApi'
import { useUiStore } from '#store'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const initial = useUiStore.getState()

beforeEach(() => {
  localStorage.clear()
  stoppedRows.length = 0
  useUiStore.setState(initial, true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const entry = (over: Partial<WorktreeListEntry> = {}): WorktreeListEntry => ({
  worktreeId: 's1',
  projectSlug: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  agentSessions: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  ...over,
})

const group = (over: Partial<WorktreeGroupSummary> = {}): WorktreeGroupSummary => ({
  groupId: 'g1',
  projectSlug: 'proj',
  name: 'Release',
  pinned: false,
  createdAt: '2026-08-10 00:00:00',
  ...over,
})

const provisioning = (over: Partial<ProvisioningWorktreeEntry> = {}): ProvisioningWorktreeEntry => ({
  worktreeId: 'p1',
  projectSlug: 'proj',
  tool: 'claude',
  kind: 'restart',
  message: 'Starting…',
  createdAt: '2026-08-10 00:00:00',
  ...over,
})

function renderList(
  worktrees: WorktreeListEntry[],
  opts: {
    groups?: WorktreeGroupSummary[]
    projectSlug?: string | null
    provisioning?: ProvisioningWorktreeEntry[]
  } = {},
): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <WorktreeList
        projectSlug={opts.projectSlug === undefined ? 'proj' : opts.projectSlug}
        worktrees={worktrees}
        groups={opts.groups ?? []}
        provisioning={opts.provisioning ?? []}
      />
    </QueryClientProvider>,
  )
}

/**
 * The list body the desktop sidebar and the mobile worktrees screen share.
 * Its ordering and group-visibility rules are covered as pure functions in
 * sidebar.test.ts; what matters here is that the rendered body agrees with
 * them and that its row and group actions work without a hover, which is the
 * only kind of interaction a phone has.
 */
describe('WorktreeList', () => {
  it('renders one flat list, with each group as its own section below it', () => {
    renderList([
      entry({ worktreeId: 'a', title: 'Loose one', status: 'waiting' }),
      entry({ worktreeId: 'b', title: 'Filed one', groupId: 'g1' }),
      entry({ worktreeId: 'c', title: 'Dying one', stopping: true }),
    ], { groups: [group()] })

    // No status headers survive — a row's own markers say what state it is in.
    expect(screen.queryByText('Waiting')).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByText('Loose one')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Release' })).toBeTruthy()
    expect(screen.getByText('Filed one')).toBeTruthy()
    // A worktree on its way out is a placeholder, not a selectable row.
    expect(screen.getByText('stopping…')).toBeTruthy()
  })

  it('ghosts a group\'s stopped members and offers them a way out of it', async () => {
    stoppedRows.push({
      worktreeId: 'gone',
      projectSlug: 'proj',
      tool: 'claude',
      createdAt: '2026-08-10 00:00:00',
      stoppedAt: '2026-08-10 01:00:00',
      title: 'Stopped one',
      seen: false,
      agentSessions: [],
      groupId: 'g1',
    })
    renderList([entry({ worktreeId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })

    expect(await screen.findByText('Stopped one')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove from group'))
    await waitFor(() => expect(setWorktreeGroup).toHaveBeenCalledWith('proj', 'gone', null))
  })

  it('opens a stopped member\'s conversation, without selecting a worktree', async () => {
    // A ghost row has no pane to open — but it does have a conversation, and
    // the stopped overlay is where that is readable. Selection must stay put:
    // there is nothing to show in the pane until it is restarted, and on a
    // phone selecting would navigate away from the list entirely.
    stoppedRows.push({
      worktreeId: 'gone',
      projectSlug: 'proj',
      tool: 'claude',
      createdAt: '2026-08-10 00:00:00',
      stoppedAt: '2026-08-10 01:00:00',
      title: 'Stopped one',
      seen: false,
      agentSessions: [],
      groupId: 'g1',
    })
    renderList([entry({ worktreeId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })

    fireEvent.click(await screen.findByText('Stopped one'))

    expect(useUiStore.getState().stoppedOverlayOpen).toBe(true)
    expect(useUiStore.getState().stoppedOverlayFocus).toBe('gone')
    expect(useUiStore.getState().selectedWorktreeId).not.toBe('gone')
  })

  // A worktree being restarted is out of the snapshot until its container is
  // back, so this placeholder is the only thing holding its place — it has to
  // hold it where the worktree lives, not at the top of the list.
  it('draws a restarting worktree inside its group', () => {
    renderList([entry({ worktreeId: 'b', title: 'Filed one', groupId: 'g1' })], {
      groups: [group()],
      provisioning: [
        provisioning({ worktreeId: 'r', groupId: 'g1' }),
        provisioning({ worktreeId: 'loose', kind: 'create' }),
      ],
    })

    const section = screen.getByRole('group', { name: 'Release' })
    expect(section.contains(screen.getByText('Restarting worktree'))).toBe(true)
    // The ungrouped one stays where every provisioning row used to go.
    expect(section.contains(screen.getByText('New worktree'))).toBe(false)
    // Counted in the section's tally alongside the live row.
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('keeps a group on screen while its last worktree restarts', () => {
    // Nothing live is left in it — an unpinned group would vanish, taking the
    // restarting row with it.
    renderList([], { groups: [group()], provisioning: [provisioning({ groupId: 'g1' })] })
    expect(screen.getByRole('group', { name: 'Release' })).toBeTruthy()
    expect(screen.getByText('Restarting worktree')).toBeTruthy()
  })

  it('selects a worktree on tap, which is what advances the mobile pane screen', () => {
    renderList([entry({ worktreeId: 'a', title: 'Fix parser' })])
    fireEvent.click(screen.getByText('Fix parser'))
    expect(useUiStore.getState().selectedWorktreeId).toBe('a')
    expect(useUiStore.getState().mobileScreen).toBe('pane')
  })

  it('exposes group and delete as real buttons — reachable without a hover', async () => {
    renderList([entry({ worktreeId: 'a', title: 'Fix parser' })])
    fireEvent.click(screen.getByLabelText('Add to group'))
    expect(await screen.findByText('Add to group')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Delete worktree'))
    expect(await screen.findByText('Delete worktree?')).toBeTruthy()
  })

  it('says what to do when there is nothing to show', () => {
    renderList([])
    expect(screen.getByText('No worktrees yet')).toBeTruthy()

    cleanup()
    renderList([], { projectSlug: null })
    expect(screen.getByText('No project selected')).toBeTruthy()
    // jsdom's matchMedia stub reports desktop, so the copy points at the rail.
    expect(screen.getByText('Pick a project from the rail on the left.')).toBeTruthy()
  })

  describe('the group dialog', () => {
    it('creates a group around the row it was opened from', async () => {
      renderList([entry({ worktreeId: 'a', title: 'Fix parser' })])
      fireEvent.click(screen.getByLabelText('Add to group'))
      fireEvent.change(await screen.findByPlaceholderText('New group name'), {
        target: { value: 'Release' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Create group' }))

      await waitFor(() => expect(createWorktreeGroup).toHaveBeenCalledWith('proj', 'a', 'Release'))
    })

    it('offers only the groups the sidebar is showing', async () => {
      // A hidden group is one whose worktrees have all stopped; moving a live
      // worktree into it would make it reappear somewhere unannounced, and a
      // drag has no way to aim at it either.
      renderList([entry({ worktreeId: 'a', title: 'Fix parser' })], {
        groups: [group({ pinned: true }), group({ groupId: 'g2', name: 'Hidden' })],
      })
      fireEvent.click(screen.getByLabelText('Add to group'))

      expect(await screen.findByRole('button', { name: 'Release' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Hidden' })).toBeNull()
    })

    // The keyboard/touch path to what dragging does with a mouse.
    it('moves the row into an existing group, and back out of one', async () => {
      renderList([entry({ worktreeId: 'a', title: 'Fix parser' })], {
        groups: [group({ pinned: true })],
      })
      fireEvent.click(screen.getByLabelText('Add to group'))
      fireEvent.click(await screen.findByRole('button', { name: 'Release' }))
      await waitFor(() => expect(setWorktreeGroup).toHaveBeenCalledWith('proj', 'a', 'g1'))

      cleanup()
      renderList([entry({ worktreeId: 'a', title: 'Fix parser', groupId: 'g1' })], { groups: [group()] })
      fireEvent.click(screen.getByLabelText('Add to group'))
      fireEvent.click(await screen.findByRole('button', { name: 'Remove from group' }))
      await waitFor(() => expect(setWorktreeGroup).toHaveBeenCalledWith('proj', 'a', null))
    })
  })

  describe('group header actions', () => {
    const renderGrouped = (): void =>
      renderList([entry({ worktreeId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })

    it('pins, deletes, and renames the group inline', async () => {
      renderGrouped()
      fireEvent.click(screen.getByLabelText('Pin group'))
      await waitFor(() => expect(setWorktreeGroupPinned).toHaveBeenCalledWith('proj', 'g1', true))

      fireEvent.click(screen.getByLabelText('Rename group'))
      const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Group name' })
      expect(input.value).toBe('Release')
      fireEvent.change(input, { target: { value: 'Shipping' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(renameWorktreeGroup).toHaveBeenCalledWith('proj', 'g1', 'Shipping'))

      fireEvent.click(screen.getByLabelText('Delete group'))
      await waitFor(() => expect(deleteWorktreeGroup).toHaveBeenCalledWith('proj', 'g1'))
    })
  })

  describe('drag between the list and a group', () => {
    /** jsdom lays nothing out, so the drop zones get the geometry the test
     *  needs: the ungrouped list on top, the group's section below it. */
    function stubZones(): void {
      const rect = (top: number, bottom: number): DOMRect =>
        ({ top, bottom, left: 0, right: 200, x: 0, y: top, width: 200, height: bottom - top,
          toJSON: () => ({}) }) as DOMRect
      screen.getByRole('group', { name: 'Ungrouped worktrees' }).getBoundingClientRect =
        () => rect(0, 100)
      screen.getByRole('group', { name: 'Release' }).getBoundingClientRect = () => rect(100, 200)
    }

    const press = (label: string, clientY: number): void => {
      fireEvent.pointerDown(screen.getByText(label), { pointerType: 'mouse', clientX: 10, clientY })
    }
    const dropAt = (clientY: number): void => {
      fireEvent.pointerMove(window, { clientX: 10, clientY })
      fireEvent.pointerUp(window, { clientX: 10, clientY })
    }

    it('files a worktree into the group it is dropped on, and back out again', async () => {
      renderList([
        entry({ worktreeId: 'a', title: 'Loose one' }),
        entry({ worktreeId: 'b', title: 'Filed one', groupId: 'g1' }),
      ], { groups: [group()] })
      stubZones()

      press('Loose one', 10)
      dropAt(150)
      await waitFor(() => expect(setWorktreeGroup).toHaveBeenCalledWith('proj', 'a', 'g1'))

      vi.mocked(setWorktreeGroup).mockClear()
      press('Filed one', 150)
      dropAt(10)
      await waitFor(() => expect(setWorktreeGroup).toHaveBeenCalledWith('proj', 'b', null))
    })

    it('leaves a press that never travels as a plain selection', () => {
      // Pinned, so the section is on screen with nothing live in it.
      renderList([entry({ worktreeId: 'a', title: 'Loose one' })], {
        groups: [group({ pinned: true })],
      })
      stubZones()

      press('Loose one', 10)
      dropAt(12) // inside the threshold
      expect(setWorktreeGroup).not.toHaveBeenCalled()
      expect(useUiStore.getState().selectedWorktreeId).toBe('a')
    })

    it('drops the drag when the pointer is cancelled, and stays dropped', () => {
      renderList([
        entry({ worktreeId: 'a', title: 'Loose one' }),
        entry({ worktreeId: 'b', title: 'Filed one', groupId: 'g1' }),
      ], { groups: [group()] })
      stubZones()

      press('Loose one', 10)
      fireEvent.pointerMove(window, { clientX: 10, clientY: 150 })
      fireEvent.pointerCancel(window, { clientX: 10, clientY: 150 })
      expect(setWorktreeGroup).not.toHaveBeenCalled()

      // The listeners came down with it, so a later unrelated pointerup can't
      // replay the move against wherever the pointer has since wandered.
      fireEvent.pointerUp(window, { clientX: 10, clientY: 150 })
      expect(setWorktreeGroup).not.toHaveBeenCalled()
    })

    it('ignores a drop back where the worktree started', () => {
      renderList([entry({ worktreeId: 'b', title: 'Filed one', groupId: 'g1' })], { groups: [group()] })
      stubZones()

      press('Filed one', 150)
      dropAt(190)
      expect(setWorktreeGroup).not.toHaveBeenCalled()
    })
  })

  describe('row rename', () => {
    /** Click a row's rename pencil to open its inline editor and return the field. */
    function openEditor(): HTMLInputElement {
      fireEvent.click(screen.getByRole('button', { name: 'Rename worktree' }))
      return screen.getByRole<HTMLInputElement>('textbox', { name: 'Worktree row title' })
    }

    it('seeds the editor from the title, falling back to the prompt', () => {
      renderList([entry({ worktreeId: 'a', title: 'My worktree', prompt: 'do a thing' })])
      expect(openEditor().value).toBe('My worktree')
      cleanup()

      renderList([entry({ worktreeId: 'a', title: '', prompt: 'do a thing' })])
      expect(openEditor().value).toBe('do a thing')
    })

    it('commits a rename on Enter and closes the editor', () => {
      renderList([entry({ worktreeId: 'a', title: 'Old' })])
      const input = openEditor()
      fireEvent.change(input, { target: { value: 'New name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(renameWorktree).toHaveBeenCalledWith('a', 'New name')
      expect(screen.queryByRole('textbox')).toBeNull()
    })

    it('commits a rename on blur', () => {
      renderList([entry({ worktreeId: 'a', title: 'Old' })])
      const input = openEditor()
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.blur(input)

      expect(renameWorktree).toHaveBeenCalledWith('a', 'Renamed')
    })

    it('reverts on Escape without renaming', () => {
      renderList([entry({ worktreeId: 'a', title: 'Old' })])
      const input = openEditor()
      fireEvent.change(input, { target: { value: 'discard me' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(renameWorktree).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox')).toBeNull()
    })

    it('does not rename when the value is unchanged', () => {
      renderList([entry({ worktreeId: 'a', title: 'Same' })])
      const input = openEditor()
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(renameWorktree).not.toHaveBeenCalled()
    })

    it('does not select the worktree when clicking the rename pencil', () => {
      renderList([entry({ worktreeId: 'a', title: 'Old' })])
      openEditor()

      expect(useUiStore.getState().selectedWorktreeId).toBeNull()
    })
  })
})
