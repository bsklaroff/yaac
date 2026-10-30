import { describe, it, expect } from 'vitest'
import { FILES_TARGET } from '#lib/files'
import {
  defaultPaneTarget,
  isSessionTarget,
  isSpecialPane,
  paneSession,
  paneStillLive,
  sessionPaneTargets,
  sessionTarget,
  sessionTargetId,
  syncPaneLayout,
} from '#lib/panes'
import { addColumn, paneTargets, singleColumn } from '#lib/layout'
import { previewTarget } from '#lib/preview'
import { sessionEntry, workspaceEntry } from './harness'

/**
 * Which panes a workspace has: one per open session, whatever its mode, plus
 * its terminals and the webapp's own. Session panes stay mounted while
 * hidden, so `paneStillLive` is what unmounts a closed session's pane.
 */

const chat = sessionEntry({ sessionId: 'sa' })
const term = sessionEntry({ sessionId: 'sb', mode: 'tui', tool: 'codex', window: 'codex-sb', ordinal: 1 })
const two = workspaceEntry({ sessions: [chat, term] })
const none = workspaceEntry()

describe('sessionTarget', () => {
  it('addresses a session pane by its id, both ways', () => {
    expect(sessionTarget('sa')).toBe('session:sa')
    expect(isSessionTarget('session:sa')).toBe(true)
    expect(isSessionTarget('window:@3')).toBe(false)
    expect(sessionTargetId('session:sa')).toBe('sa')
    // A session pane is not one the webapp keeps on its own.
    expect(isSpecialPane('session:sa')).toBe(false)
  })
})

describe('paneSession', () => {
  it('finds an open session behind its pane, and nothing behind any other', () => {
    expect(paneSession(two, 'session:sb')).toBe(term)
    expect(paneSession(two, 'session:gone')).toBeUndefined()
    expect(paneSession(two, 'window:@3')).toBeUndefined()
    expect(paneSession(undefined, 'session:sa')).toBeUndefined()
  })
})

describe('sessionPaneTargets', () => {
  it('lists every open session, chat and terminal alike, in order', () => {
    expect(sessionPaneTargets(two)).toEqual(['session:sa', 'session:sb'])
    expect(sessionPaneTargets(none)).toEqual([])
    expect(sessionPaneTargets(undefined)).toEqual([])
  })
})

describe('defaultPaneTarget', () => {
  it('opens the first session, and nothing for a workspace with none', () => {
    expect(defaultPaneTarget(two)).toBe('session:sa')
    expect(defaultPaneTarget(none)).toBeUndefined()
    expect(defaultPaneTarget(undefined)).toBeUndefined()
  })
})

describe('paneStillLive', () => {
  it('keeps an open session\'s pane and drops a closed one\'s', () => {
    expect(paneStillLive(two, 'session:sa')).toBe(true)
    expect(paneStillLive(workspaceEntry({ sessions: [term] }), 'session:sa')).toBe(false)
  })

  it('keeps a terminal pane while its window is listed, and special panes always', () => {
    const shell = { target: 'window:@3', name: 'shell' }
    for (const ws of [two, none]) {
      // Windows not listed yet: nothing is known to be gone.
      expect(paneStillLive(ws, 'window:@3')).toBe(true)
      expect(paneStillLive({ ...ws, terminals: [shell] }, 'window:@3')).toBe(true)
      expect(paneStillLive({ ...ws, terminals: [] }, 'window:@3')).toBe(false)
      expect(paneStillLive({ ...ws, terminals: [] }, previewTarget(3000))).toBe(true)
      expect(paneStillLive({ ...ws, terminals: [] }, FILES_TARGET)).toBe(true)
    }
  })
})

describe('syncPaneLayout', () => {
  it('appends new sessions and windows, drops closed and killed ones, and keeps special panes', () => {
    const layout = addColumn(addColumn(singleColumn('session:gone'), '%1'), previewTarget(3000))
    const next = syncPaneLayout(layout, two, ['%2'])
    expect(paneTargets(next)).toEqual([previewTarget(3000), 'session:sa', 'session:sb', '%2'])
    // Already in line: the same reference, so nothing is stored.
    expect(syncPaneLayout(next, two, ['%2'])).toBe(next)
  })

  it('drops the panes a stored layout kept from before sessions', () => {
    const legacy = addColumn(addColumn(singleColumn('agent'), 'acp:conv-a'), '%1')
    expect(paneTargets(syncPaneLayout(legacy, workspaceEntry({ sessions: [chat] }), ['%1'])))
      .toEqual(['%1', 'session:sa'])
  })

  it('leaves a workspace with no session and no window with no pane', () => {
    expect(syncPaneLayout([], none, [])).toEqual([])
  })
})
