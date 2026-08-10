// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, renderHook, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { MobileScreenLayer } from '#components/mobile/MobileScreenLayer'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { goBackScreen, resetMobileHistory, useMobileHistory } from '#lib/mobileHistory'
import { useUiStore } from '#store'

const initial = useUiStore.getState()

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState(initial, true)
  window.history.replaceState({}, '', '/')
  resetMobileHistory()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Model a history navigation the way a browser does it: the entry moves first,
 * *then* popstate fires. jsdom won't walk the stack for a synthetic event, so
 * the test has to put the destination entry in place itself — and it matters,
 * because the shell relies on the current entry already agreeing with the
 * event to know a change came from history rather than from a tap.
 */
function popTo(state: { yaacScreen: string; yaacDepth: number }): void {
  act(() => {
    window.history.replaceState(state, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate', { state }))
  })
}

describe('MobileScreenLayer', () => {
  it('keeps every screen mounted, showing only the active one', () => {
    render(
      <>
        <MobileScreenLayer active={false}><p>projects</p></MobileScreenLayer>
        <MobileScreenLayer active><p>worktrees</p></MobileScreenLayer>
        <MobileScreenLayer active={false}><p>pane</p></MobileScreenLayer>
      </>,
    )
    // All three are in the tree — the pane's terminals must never be
    // unmounted just because another screen is showing.
    expect(screen.getByText('projects')).toBeTruthy()
    expect(screen.getByText('worktrees')).toBeTruthy()
    expect(screen.getByText('pane')).toBeTruthy()
  })

  it('hides an inactive screen with visibility, never display, and makes it inert', () => {
    const { container } = render(
      <MobileScreenLayer active={false}><p>pane</p></MobileScreenLayer>,
    )
    const layer = container.firstElementChild as HTMLElement
    // `invisible` (visibility: hidden) keeps the box laid out, so the pane's
    // ResizeObserver still measures a real size; `hidden` would collapse every
    // terminal rect to zero.
    expect(layer.className).toContain('invisible')
    expect(layer.className).not.toMatch(/\bhidden\b/)
    expect(layer.className).toContain('pointer-events-none')
    expect(layer.hasAttribute('inert')).toBe(true)
  })

  it('leaves the active screen visible and interactive', () => {
    const { container } = render(<MobileScreenLayer active><p>pane</p></MobileScreenLayer>)
    const layer = container.firstElementChild as HTMLElement
    expect(layer.className).not.toContain('invisible')
    expect(layer.hasAttribute('inert')).toBe(false)
  })
})

describe('MobileHeader', () => {
  it('shows a back affordance only when one is given', () => {
    const onBack = vi.fn()
    const { rerender } = render(<MobileHeader title="yaac" />)
    expect(screen.queryByLabelText('Back')).toBeNull()

    rerender(<MobileHeader title="proj" onBack={onBack} backLabel="Back to projects" />)
    fireEvent.click(screen.getByLabelText('Back to projects'))
    expect(onBack).toHaveBeenCalledOnce()
  })
})

describe('goBackScreen', () => {
  it('pops the history stack once there is an entry of ours to pop', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().selectWorktree('s1') })

    goBackScreen()
    expect(back).toHaveBeenCalledOnce()
    // Nothing moved yet — the popstate listener is what applies the change,
    // which is exactly what makes the chevron and the hardware button one
    // and the same navigation.
    expect(useUiStore.getState().mobileScreen).toBe('pane')
  })

  it('steps up by hand on a cold load, instead of walking out of the app', () => {
    // A reload that restored `pane` from localStorage: one history entry, and
    // it is the one we're standing on. back() here would leave the app.
    useUiStore.setState({ mobileScreen: 'pane' })
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useMobileHistory(true))

    act(() => { goBackScreen() })
    expect(back).not.toHaveBeenCalled()
    expect(useUiStore.getState().mobileScreen).toBe('worktrees')
    // And stepping up must not deepen the stack it just failed to find.
    expect(push).not.toHaveBeenCalled()
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('worktrees')
  })

  it('is a no-op at the root — there is nothing above the project list', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    renderHook(() => useMobileHistory(true))
    act(() => { goBackScreen() })
    expect(back).not.toHaveBeenCalled()
    expect(useUiStore.getState().mobileScreen).toBe('projects')
  })
})

describe('useMobileHistory', () => {
  it('stamps the entry it starts on instead of pushing a screenless one under it', () => {
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useMobileHistory(true))
    expect(push).not.toHaveBeenCalled()
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('projects')
  })

  it('pushes an entry when the screen advances', () => {
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useMobileHistory(true))

    act(() => { useUiStore.getState().setActiveProject('proj') })
    expect(push).toHaveBeenCalledOnce()
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('worktrees')

    act(() => { useUiStore.getState().selectWorktree('s1') })
    expect(push).toHaveBeenCalledTimes(2)
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('pane')
  })

  it('applies a popstate without pushing a duplicate entry back on', () => {
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().selectWorktree('s1') })

    const push = vi.spyOn(window.history, 'pushState')
    popTo({ yaacScreen: 'worktrees', yaacDepth: 0 })
    expect(useUiStore.getState().mobileScreen).toBe('worktrees')
    expect(push).not.toHaveBeenCalled()
  })

  it('stamps a depth on every entry, so a pop knows where it landed', () => {
    renderHook(() => useMobileHistory(true))
    expect((window.history.state as { yaacDepth?: number }).yaacDepth).toBe(0)
    act(() => { useUiStore.getState().setActiveProject('proj') })
    expect((window.history.state as { yaacDepth?: number }).yaacDepth).toBe(1)
    act(() => { useUiStore.getState().selectWorktree('s1') })
    expect((window.history.state as { yaacDepth?: number }).yaacDepth).toBe(2)
  })

  it('reads depth off the entry, so a forward navigation doesn’t undercount', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().setActiveProject('proj') })
    act(() => { useUiStore.getState().selectWorktree('s1') })

    // Back to worktrees, then forward again to the pane. A module counter
    // decremented on every popstate would read 0 here and send the chevron
    // down the cold-load path, duplicating an entry and deadening the next
    // hardware back press.
    popTo({ yaacScreen: 'worktrees', yaacDepth: 1 })
    popTo({ yaacScreen: 'pane', yaacDepth: 2 })

    goBackScreen()
    expect(back).toHaveBeenCalledOnce()
  })

  it('a pop onto a same-screen entry cannot swallow the next push', () => {
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().setActiveProject('proj') })
    push.mockClear()

    // A dead back press: the entry below happens to carry the same screen, so
    // the store write is a no-op. A "came from popstate" flag set here would
    // never be consumed, and would eat the real navigation that follows.
    popTo({ yaacScreen: 'worktrees', yaacDepth: 0 })

    act(() => { useUiStore.getState().selectWorktree('s1') })
    expect(push).toHaveBeenCalledOnce()
    expect(window.history.state).toMatchObject({ yaacScreen: 'pane', yaacDepth: 1 })
  })

  it('treats an entry with no screen — one from before the app — as the root', () => {
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().selectWorktree('s1') })
    act(() => {
      window.history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    })
    expect(useUiStore.getState().mobileScreen).toBe('projects')
    // And the unstamped entry gets stamped in place rather than pushed onto.
    expect(window.history.state).toMatchObject({ yaacScreen: 'projects', yaacDepth: 0 })
  })

  it('stamps nothing while disabled — the desktop layout has no screens', () => {
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useMobileHistory(false))
    act(() => { useUiStore.getState().selectWorktree('s1') })
    expect(push).not.toHaveBeenCalled()
    // persistSelection still mirrors the selection into the URL — that is its
    // own replaceState and nothing to do with screens. What must not appear
    // is a screen entry.
    expect((window.history.state as { yaacScreen?: string } | null)?.yaacScreen).toBeUndefined()
  })

  it('survives persistSelection rewriting the current entry’s URL', () => {
    renderHook(() => useMobileHistory(true))
    // persistSelection replaceStates the selection into the query string on
    // every selection change; it must preserve the screen stamped there, or
    // back navigation silently degrades to a replace.
    act(() => { useUiStore.getState().setActiveProject('proj') })
    expect(window.location.search).toContain('project=proj')
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('worktrees')
  })
})
