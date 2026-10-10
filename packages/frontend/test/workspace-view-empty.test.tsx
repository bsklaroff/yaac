// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import type { ServerSnapshot } from '@yaac/shared/types'
import { WorkspaceView } from '#components/WorkspaceView'
import { useUiStore } from '#lib/store'
import { renderWithClient } from './harness'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const initial = useUiStore.getState()
afterEach(() => {
  cleanup()
  useUiStore.setState(initial, true)
})

/** A snapshot whose only workspaces in `proj` are `stoppedCount` stops. */
const snapshot = (stoppedCount: number): ServerSnapshot => ({
  workspaces: [],
  projects: [{ id: 'proj', stoppedCount }],
  queuedWorkspaces: [],
  heldWorkspaces: [],
  draftWorkspaces: [],
}) as unknown as ServerSnapshot

describe('WorkspaceView with nothing selected', () => {
  it('says no workspace is open while the project has any, stopped ones included', () => {
    useUiStore.setState({ activeProjectId: 'proj', selectedWorkspaceId: null })
    renderWithClient(<WorkspaceView snapshot={snapshot(3)} provisioning={[]} />)
    expect(screen.getByText('No workspace open')).toBeTruthy()

    cleanup()
    renderWithClient(<WorkspaceView snapshot={snapshot(0)} provisioning={[]} />)
    expect(screen.getByText('No workspaces yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: /New workspace/ })).toBeTruthy()
  })
})
