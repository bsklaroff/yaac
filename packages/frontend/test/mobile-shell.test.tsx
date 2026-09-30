// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, renderHook, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { MobileScreenLayer } from '#components/mobile/MobileScreenLayer'
import { MobileHeader } from '#components/mobile/MobileHeader'
import { goBackScreen, resetMobileHistory, useMobileHistory } from '#lib/mobileHistory'
import { useUiStore } from '#lib/store'

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
 * Simulate a history navigation as a browser does it: the entry changes,
 * then popstate fires. jsdom doesn't do this for a synthetic event, and the
 * shell relies on the current entry already matching the event.
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
        <MobileScreenLayer active><p>workspaces</p></MobileScreenLayer>
        <MobileScreenLayer active={false}><p>pane</p></MobileScreenLayer>
      </>,
    )
    // All three stay mounted, so the pane's terminals aren't unmounted.
    expect(screen.getByText('projects')).toBeTruthy()
    expect(screen.getByText('workspaces')).toBeTruthy()
    expect(screen.getByText('pane')).toBeTruthy()
  })

  it('hides an inactive screen with visibility, never display, and makes it inert', () => {
    const { container } = render(
      <MobileScreenLayer active={false}><p>pane</p></MobileScreenLayer>,
    )
    const layer = container.firstElementChild as HTMLElement
    // `invisible` keeps the layout, so terminals still measure a real size;
    // `hidden` would collapse them to zero.
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
    act(() => { useUiStore.getState().selectWorkspace('s1') })

    goBackScreen()
    expect(back).toHaveBeenCalledOnce()
    // Nothing changes until popstate, so the chevron and the hardware back
    // button behave the same.
    expect(useUiStore.getState().mobileScreen).toBe('pane')
  })

  it('steps up by hand on a cold load, instead of walking out of the app', () => {
    // A reload restored `pane` with a single history entry, so back() would
    // leave the app.
    useUiStore.setState({ mobileScreen: 'pane' })
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useMobileHistory(true))

    act(() => { goBackScreen() })
    expect(back).not.toHaveBeenCalled()
    expect(useUiStore.getState().mobileScreen).toBe('workspaces')
    // Stepping up replaces the entry rather than pushing.
    expect(push).not.toHaveBeenCalled()
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('workspaces')
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
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('workspaces')

    act(() => { useUiStore.getState().selectWorkspace('s1') })
    expect(push).toHaveBeenCalledTimes(2)
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('pane')
  })

  it('applies a popstate without pushing a duplicate entry back on', () => {
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().selectWorkspace('s1') })

    const push = vi.spyOn(window.history, 'pushState')
    popTo({ yaacScreen: 'workspaces', yaacDepth: 0 })
    expect(useUiStore.getState().mobileScreen).toBe('workspaces')
    expect(push).not.toHaveBeenCalled()
  })

  it('stamps a depth on every entry, so a pop knows where it landed', () => {
    renderHook(() => useMobileHistory(true))
    expect((window.history.state as { yaacDepth?: number }).yaacDepth).toBe(0)
    act(() => { useUiStore.getState().setActiveProject('proj') })
    expect((window.history.state as { yaacDepth?: number }).yaacDepth).toBe(1)
    act(() => { useUiStore.getState().selectWorkspace('s1') })
    expect((window.history.state as { yaacDepth?: number }).yaacDepth).toBe(2)
  })

  it('reads depth off the entry, so a forward navigation doesn’t undercount', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().setActiveProject('proj') })
    act(() => { useUiStore.getState().selectWorkspace('s1') })

    // Back to workspaces, then forward to the pane. The depth must come from
    // the entry; a counter decremented per popstate would read 0 here.
    popTo({ yaacScreen: 'workspaces', yaacDepth: 1 })
    popTo({ yaacScreen: 'pane', yaacDepth: 2 })

    goBackScreen()
    expect(back).toHaveBeenCalledOnce()
  })

  it('a pop onto a same-screen entry cannot swallow the next push', () => {
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().setActiveProject('proj') })
    push.mockClear()

    // A back press onto an entry with the same screen changes nothing, and
    // must not break the next navigation.
    popTo({ yaacScreen: 'workspaces', yaacDepth: 0 })

    act(() => { useUiStore.getState().selectWorkspace('s1') })
    expect(push).toHaveBeenCalledOnce()
    expect(window.history.state).toMatchObject({ yaacScreen: 'pane', yaacDepth: 1 })
  })

  it('treats an entry with no screen — one from before the app — as the root', () => {
    renderHook(() => useMobileHistory(true))
    act(() => { useUiStore.getState().selectWorkspace('s1') })
    act(() => {
      window.history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    })
    expect(useUiStore.getState().mobileScreen).toBe('projects')
    // The unstamped entry is stamped in place, not pushed onto.
    expect(window.history.state).toMatchObject({ yaacScreen: 'projects', yaacDepth: 0 })
  })

  it('stamps nothing while disabled — the desktop layout has no screens', () => {
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useMobileHistory(false))
    act(() => { useUiStore.getState().selectWorkspace('s1') })
    expect(push).not.toHaveBeenCalled()
    // persistSelection still writes the URL, but no screen is stamped.
    expect((window.history.state as { yaacScreen?: string } | null)?.yaacScreen).toBeUndefined()
  })

  it('survives persistSelection rewriting the current entry’s URL', () => {
    renderHook(() => useMobileHistory(true))
    // persistSelection's replaceState must keep the stamped screen.
    act(() => { useUiStore.getState().setActiveProject('proj') })
    expect(window.location.search).toContain('project=proj')
    expect((window.history.state as { yaacScreen?: string }).yaacScreen).toBe('workspaces')
  })
})
