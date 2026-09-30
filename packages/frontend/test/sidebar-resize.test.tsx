// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('#lib/stoppedApi', () => ({ getStoppedWorkspaces: vi.fn(() => Promise.resolve([])) }))
vi.mock('#lib/createWorkspace', () => ({
  dismissProvisioning: vi.fn(),
  restartWorkspace: vi.fn(),
  renameWorkspace: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/groupApi', () => ({
  createWorkspaceGroup: vi.fn(() => Promise.resolve({ groupId: 'g-new' })),
  renameWorkspaceGroup: vi.fn(() => Promise.resolve()),
  setWorkspaceGroupPinned: vi.fn(() => Promise.resolve()),
  deleteWorkspaceGroup: vi.fn(() => Promise.resolve()),
  setWorkspaceGroup: vi.fn(() => Promise.resolve()),
}))
vi.mock('#lib/stopWorkspaceFlow', () => ({ stopWorkspaceOptimistic: vi.fn() }))
vi.mock('#lib/useProvisionWorkspace', () => ({ useProvisionWorkspace: () => vi.fn() }))

import { Sidebar } from '#components/Sidebar'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  loadSidebarWidth,
  useUiStore,
} from '#lib/store'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // jsdom has no pointer capture; the handle calls it on every drag.
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
})

const initial = useUiStore.getState()

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState(initial, true)
})

afterEach(() => {
  cleanup()
  document.body.className = ''
})

/** The sidebar with no project selected: the handle, without project menus. */
function renderSidebar(): HTMLElement {
  render(
    <QueryClientProvider client={new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })}
    >
      <Sidebar
        projectSlug={null}
        projectRemoteUrl=""
        workspaces={[]}
        groups={[]}
        queued={[]}
        held={[]}
        drafts={[]}
        provisioning={[]}
        connected
        gitAuthFailures={[]}
      />
    </QueryClientProvider>,
  )
  return screen.getByRole('separator', { name: 'Resize sidebar' })
}

/** Press on the handle at `from`, move to `to`, release. */
function drag(handle: HTMLElement, from: number, to: number): void {
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: from })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to })
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: to })
}

const width = (): number => useUiStore.getState().sidebarWidth

describe('sidebar resize', () => {
  it('starts at the persisted width and follows the drag', () => {
    const handle = renderSidebar()
    const aside = handle.closest('aside') as HTMLElement
    expect(width()).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(aside.style.width).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`)

    drag(handle, 300, 380)
    expect(width()).toBe(DEFAULT_SIDEBAR_WIDTH + 80)
    expect(aside.style.width).toBe(`${DEFAULT_SIDEBAR_WIDTH + 80}px`)

    // …and the next drag starts from the width it left behind.
    drag(handle, 380, 340)
    expect(width()).toBe(DEFAULT_SIDEBAR_WIDTH + 40)
  })

  // The handle's z-10 must stay inside the sidebar's stacking context, or it
  // would cover popups portaled to <body>. jsdom can only check the class;
  // test-playwright-scripts/sidebar-popup-over-resize-handle.js checks the
  // real layering.
  it('keeps the handle stacked inside the sidebar', () => {
    const handle = renderSidebar()
    const aside = handle.closest('aside') as HTMLElement
    expect(aside.className).toContain('isolate')
    expect(handle.className).toContain('z-10')
  })

  it('persists the dragged width and restores it', () => {
    const handle = renderSidebar()
    drag(handle, 300, 360)
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH + 60)
  })

  it('clamps to the bounds, however far the pointer travels', () => {
    const handle = renderSidebar()
    drag(handle, 300, -5000)
    expect(width()).toBe(MIN_SIDEBAR_WIDTH)
    drag(handle, 300, 5000)
    expect(width()).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('marks the document as resizing only while the drag is live', () => {
    const handle = renderSidebar()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 300 })
    expect(document.body.classList.contains('col-resizing')).toBe(true)
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 300 })
    expect(document.body.classList.contains('col-resizing')).toBe(false)
  })

  it('ignores pointer moves once the drag has ended', () => {
    const handle = renderSidebar()
    drag(handle, 300, 320)
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 })
    expect(width()).toBe(DEFAULT_SIDEBAR_WIDTH + 20)
  })

  it('resizes by keyboard and resets on double-click', () => {
    const handle = renderSidebar()
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(width()).toBe(DEFAULT_SIDEBAR_WIDTH + 16)
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(width()).toBe(DEFAULT_SIDEBAR_WIDTH - 32)

    fireEvent.doubleClick(handle)
    expect(width()).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('falls back to the default for junk or an out-of-bounds store', () => {
    localStorage.setItem('yaac.sidebarwidth.v1', 'wide please')
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
    localStorage.removeItem('yaac.sidebarwidth.v1')
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
    // An out-of-range saved width is clamped.
    localStorage.setItem('yaac.sidebarwidth.v1', '4000')
    expect(loadSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH)
  })
})
