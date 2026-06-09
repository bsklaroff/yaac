import { describe, it, expect, beforeEach } from 'vitest'
import { useUiStore } from '@/frontend/store'

const initial = useUiStore.getState()

beforeEach(() => {
  useUiStore.setState(initial, true)
})

describe('pending-delete tracking', () => {
  it('beginDelete adds an id, with no duplicates', () => {
    useUiStore.getState().beginDelete('a')
    useUiStore.getState().beginDelete('a')
    useUiStore.getState().beginDelete('b')
    expect(useUiStore.getState().pendingDeleteIds).toEqual(['a', 'b'])
  })

  it('endDelete removes a tracked id and is a no-op for untracked ones', () => {
    useUiStore.getState().beginDelete('a')
    useUiStore.getState().beginDelete('b')
    useUiStore.getState().endDelete('a')
    expect(useUiStore.getState().pendingDeleteIds).toEqual(['b'])
    useUiStore.getState().endDelete('missing')
    expect(useUiStore.getState().pendingDeleteIds).toEqual(['b'])
  })
})

describe('selection + project switching', () => {
  it('selectSession sets the selected id', () => {
    useUiStore.getState().selectSession('s1')
    expect(useUiStore.getState().selectedSessionId).toBe('s1')
  })

  it('setActiveProject clears the open session', () => {
    useUiStore.getState().selectSession('s1')
    useUiStore.getState().setActiveProject('proj')
    expect(useUiStore.getState().activeProjectSlug).toBe('proj')
    expect(useUiStore.getState().selectedSessionId).toBeNull()
  })

  it('openSession sets both project and session', () => {
    useUiStore.getState().openSession('proj', 's2')
    expect(useUiStore.getState().activeProjectSlug).toBe('proj')
    expect(useUiStore.getState().selectedSessionId).toBe('s2')
  })

  it('reconnectTerminal bumps only the target session nonce', () => {
    useUiStore.getState().reconnectTerminal('t1')
    useUiStore.getState().reconnectTerminal('t1')
    useUiStore.getState().reconnectTerminal('t2')
    expect(useUiStore.getState().terminalNonces).toEqual({ t1: 2, t2: 1 })
  })
})
