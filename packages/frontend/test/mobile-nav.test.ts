// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { loadMobileScreen, persistMobileScreen, useUiStore } from '#lib/store'

const initial = useUiStore.getState()

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState(initial, true)
})

/**
 * Mobile screen navigation. App auto-selects a workspace when a project
 * opens; that must not count as navigation, or opening a project would skip
 * its workspace list.
 */
describe('mobile screen navigation', () => {
  it('a project tap moves to that project’s workspace list', () => {
    useUiStore.getState().setActiveProject('proj')
    expect(useUiStore.getState().mobileScreen).toBe('workspaces')
    expect(useUiStore.getState().activeProjectSlug).toBe('proj')
    // Switching projects still drops the old project's workspace.
    expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
  })

  it('clearing the project (its removal) falls back to the project list', () => {
    useUiStore.getState().setActiveProject('proj')
    useUiStore.getState().setActiveProject(null)
    expect(useUiStore.getState().mobileScreen).toBe('projects')
  })

  it('a workspace tap moves to the pane', () => {
    useUiStore.getState().setActiveProject('proj')
    useUiStore.getState().selectWorkspace('s1')
    expect(useUiStore.getState().mobileScreen).toBe('pane')
    expect(useUiStore.getState().selectedWorkspaceId).toBe('s1')
  })

  it('auto-select fills the pane WITHOUT navigating to it', () => {
    useUiStore.getState().setActiveProject('proj')
    useUiStore.getState().autoSelectWorkspace('s1')
    expect(useUiStore.getState().selectedWorkspaceId).toBe('s1')
    expect(useUiStore.getState().mobileScreen).toBe('workspaces')
  })

  it('auto-select still bumps focusNonce, like a tap', () => {
    const before = useUiStore.getState().focusNonce
    useUiStore.getState().autoSelectWorkspace('s1')
    expect(useUiStore.getState().focusNonce).toBe(before + 1)
  })

  it('deselecting (dismissing a failed provisioning row) stays put', () => {
    useUiStore.getState().setActiveProject('proj')
    useUiStore.getState().selectWorkspace(null)
    expect(useUiStore.getState().mobileScreen).toBe('workspaces')
    expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
  })

  it('openWorkspace — a deep link or a just-created workspace — lands on the pane', () => {
    useUiStore.getState().openWorkspace('other', 's9')
    expect(useUiStore.getState().activeProjectSlug).toBe('other')
    expect(useUiStore.getState().selectedWorkspaceId).toBe('s9')
    expect(useUiStore.getState().mobileScreen).toBe('pane')
  })

  it('setMobileScreen is a no-op for the screen already showing', () => {
    const before = useUiStore.getState()
    useUiStore.getState().setMobileScreen('projects')
    expect(useUiStore.getState()).toBe(before)
  })
})

describe('mobile screen persistence', () => {
  it('round-trips through localStorage', () => {
    persistMobileScreen('pane')
    expect(loadMobileScreen()).toBe('pane')
  })

  it('defaults to the project list with nothing stored, or something bogus', () => {
    expect(loadMobileScreen()).toBe('projects')
    localStorage.setItem('yaac.mobilescreen.v1', 'wat')
    expect(loadMobileScreen()).toBe('projects')
  })

  it('opens a shared link on the screen it points at, on a device that has never visited', () => {
    window.history.replaceState({}, '', '/?project=p&workspace=s1')
    expect(loadMobileScreen()).toBe('pane')
    window.history.replaceState({}, '', '/?project=p')
    expect(loadMobileScreen()).toBe('workspaces')
    window.history.replaceState({}, '', '/')
  })

  it('lets a stored screen win over the URL, which every visit mirrors into', () => {
    // The URL always has the params after any use, so a saved screen must
    // win over them.
    persistMobileScreen('workspaces')
    window.history.replaceState({}, '', '/?project=p&workspace=s1')
    expect(loadMobileScreen()).toBe('workspaces')
    window.history.replaceState({}, '', '/')
  })

  it('is written by the store whenever the screen changes', () => {
    useUiStore.getState().selectWorkspace('s1')
    expect(localStorage.getItem('yaac.mobilescreen.v1')).toBe('pane')
  })
})
