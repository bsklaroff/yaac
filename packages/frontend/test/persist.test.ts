// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  MAX_EDITOR_FONT_SIZE, MAX_SIDEBAR_WIDTH, MIN_EDITOR_FONT_SIZE, chatDraftKey, flushChatDrafts, loadPersisted,
  loadSelection, persistSelection, useUiStore,
} from '#lib/store'
import { addColumn, singleColumn } from '#lib/layout'

/**
 * The store's saved fields: each is written under its own localStorage key
 * when it changes, and loads back only when valid. `loads` pairs a stored
 * raw value with what loads from it (undefined: rejected, so the default
 * applies).
 */

const initial = useUiStore.getState()

beforeEach(() => {
  // Resetting the store saves its fields, so clear storage after.
  useUiStore.setState(initial, true)
  flushChatDrafts()
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  // Also clears the draft debounce timer, so no write lands after teardown.
  flushChatDrafts()
})

const LAYOUTS = { s1: addColumn(singleColumn('agent'), 'shell:shell'), s2: [] }

const CASES: { field: keyof typeof initial; key: string; value: unknown; stored: string; loads: [string, unknown][] }[] = [
  { field: 'soundEnabled', key: 'yaac.sound.v1', value: false, stored: '0', loads: [['1', true], ['x', undefined]] },
  { field: 'chatFullWidth', key: 'yaac.chatfullwidth.v1', value: true, stored: '1', loads: [['0', false]] },
  {
    field: 'sidebarWidth', key: 'yaac.sidebarwidth.v1', value: 300, stored: '300',
    loads: [['4000', MAX_SIDEBAR_WIDTH], ['wide please', undefined], [' ', undefined]],
  },
  {
    field: 'editorFontSize', key: 'yaac.editorfontsize.v1', value: 15, stored: '15',
    loads: [['400', MAX_EDITOR_FONT_SIZE], ['1', MIN_EDITOR_FONT_SIZE], ['big', undefined], [' ', undefined]],
  },
  { field: 'viewMode', key: 'yaac.viewmode.v1', value: 'tabs', stored: 'tabs', loads: [['garbage', undefined]] },
  { field: 'mobileScreen', key: 'yaac.mobilescreen.v1', value: 'pane', stored: 'pane', loads: [['wat', undefined]] },
  { field: 'themePref', key: 'yaac.theme.v1', value: 'light', stored: 'light', loads: [['sepia', undefined]] },
  {
    field: 'pinnedUsageMetric', key: 'yaac.pinnedusage.v1', value: 'weekly_scoped:Fable',
    stored: 'weekly_scoped:Fable', loads: [['', undefined]],
  },
  {
    field: 'layouts', key: 'yaac.layouts.v2', value: LAYOUTS, stored: JSON.stringify(LAYOUTS),
    loads: [
      [JSON.stringify({
        ok: [{ tabs: ['agent'], active: 'agent' }],
        // active not a member of tabs; empty tabs; not a group list; a tree.
        bad1: [{ tabs: ['x'], active: 'y' }],
        bad2: [{ tabs: [], active: 'x' }],
        bad3: 42,
        bad4: { type: 'leaf', target: 'agent' },
      }), { ok: [{ tabs: ['agent'], active: 'agent' }] }],
      ['{{{', undefined],
      ['"a string"', undefined],
    ],
  },
  {
    field: 'readWaiting', key: 'yaac.readwaiting.v1', value: { a: 100, b: 200 }, stored: '{"a":100,"b":200}',
    loads: [[JSON.stringify({ a: 100, b: 'nope', c: null }), { a: 100 }], ['["a","b"]', undefined]],
  },
]

describe.each(CASES)('$field', ({ field, key, value, stored, loads }) => {
  it(`is saved under ${key} as it changes, and loads back`, () => {
    useUiStore.setState({ [field]: value })
    expect(localStorage.getItem(key)).toBe(stored)
    expect(loadPersisted()[field]).toEqual(value)
  })

  it('loads only valid stored values', () => {
    expect(loadPersisted()).not.toHaveProperty(field)
    for (const [raw, loaded] of loads) {
      localStorage.setItem(key, raw)
      expect(loadPersisted()[field]).toEqual(loaded)
    }
  })
})

describe('saved fields', () => {
  it('ignores layouts saved under the old (v1) key', () => {
    localStorage.setItem('yaac.layouts.v1', JSON.stringify({ s1: { type: 'leaf', target: 'agent' } }))
    expect(loadPersisted().layouts).toBeUndefined()
  })

  it('setters clamp before saving', () => {
    useUiStore.getState().setEditorFontSize(100)
    expect(localStorage.getItem('yaac.editorfontsize.v1')).toBe(String(MAX_EDITOR_FONT_SIZE))
  })

  it('removes the pin key on null', () => {
    useUiStore.getState().setPinnedUsageMetric('session')
    useUiStore.getState().setPinnedUsageMetric(null)
    expect(localStorage.getItem('yaac.pinnedusage.v1')).toBeNull()
  })

  it('load nothing and save nothing without localStorage', () => {
    const real = globalThis.localStorage
    delete (globalThis as Record<string, unknown>).localStorage
    try {
      expect(loadPersisted()).toEqual({})
      expect(() => useUiStore.getState().setSoundEnabled(false)).not.toThrow()
    } finally {
      ;(globalThis as Record<string, unknown>).localStorage = real
    }
  })
})

describe('chat drafts', () => {
  it('validates each draft on load', () => {
    localStorage.setItem('yaac.chatdrafts.v1', JSON.stringify({
      a: { text: 'keep' },
      w: { text: 'sent, unconfirmed', sent: 'sent, unconfirmed' },
      b: 'a bare string',
      c: { text: 42 },
      d: { text: 'bad marker', sent: 7 },
      e: { text: '' },
      f: null,
    }))
    expect(loadPersisted().chatDrafts).toEqual({
      a: { text: 'keep' },
      w: { text: 'sent, unconfirmed', sent: 'sent, unconfirmed' },
    })
  })

  it('keeps an oversized paste in memory but out of localStorage', () => {
    // A huge draft isn't saved, so it can't exhaust the quota.
    useUiStore.getState().setChatDraft('w1', 'acp-1', 'x'.repeat(64 * 1024 + 1))
    useUiStore.getState().setChatDraft('w2', 'acp-1', 'small')
    flushChatDrafts()
    expect(loadPersisted().chatDrafts).toEqual({ 'w2|acp-1': { text: 'small' } })
  })

  it('writes drafts through the store, keyed per conversation', () => {
    const { setChatDraft } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'first conversation')
    setChatDraft('w1', 'acp-2', 'second conversation')
    flushChatDrafts()
    expect(loadPersisted().chatDrafts).toEqual({
      [chatDraftKey('w1', 'acp-1')]: { text: 'first conversation' },
      [chatDraftKey('w1', 'acp-2')]: { text: 'second conversation' },
    })
  })

  it('drops the key when the box is emptied, rather than storing an empty draft', () => {
    const { setChatDraft } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'typed then sent')
    setChatDraft('w1', 'acp-1', '')
    flushChatDrafts()
    expect(useUiStore.getState().chatDrafts).toEqual({})
    expect(loadPersisted().chatDrafts).toEqual({})
  })

  it('records what went to the socket, and forgets it once settled', () => {
    const { setChatDraft, setChatSent } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'ship it')
    setChatSent('w1', 'acp-1', 'ship it')
    expect(useUiStore.getState().chatDrafts).toEqual({
      [chatDraftKey('w1', 'acp-1')]: { text: 'ship it', sent: 'ship it' },
    })
    // With nothing typed and nothing in flight, the key is removed.
    setChatDraft('w1', 'acp-1', '')
    setChatSent('w1', 'acp-1', undefined)
    expect(useUiStore.getState().chatDrafts).toEqual({})
  })

  it('drops the marker when the text is edited', () => {
    // New text drops the `sent` marker.
    const { setChatDraft, setChatSent } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'ok')
    setChatSent('w1', 'acp-1', 'ok')
    setChatDraft('w1', 'acp-1', 'ok, and one more thing')
    expect(useUiStore.getState().chatDrafts).toEqual({
      [chatDraftKey('w1', 'acp-1')]: { text: 'ok, and one more thing' },
    })
  })

  it('settles the marker when the box is emptied, leaving no key', () => {
    // Emptying the box removes the whole entry, marker included.
    const { setChatDraft, setChatSent } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'ok')
    setChatSent('w1', 'acp-1', 'ok')
    setChatDraft('w1', 'acp-1', '')
    expect(useUiStore.getState().chatDrafts).toEqual({})
  })

  it('leaves state untouched when nothing changed', () => {
    const { setChatDraft, setChatSent } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'same')
    setChatSent('w1', 'acp-1', 'same')
    const before = useUiStore.getState().chatDrafts
    setChatDraft('w1', 'acp-1', 'same')
    setChatSent('w1', 'acp-1', 'same')
    expect(useUiStore.getState().chatDrafts).toBe(before)
  })

  it('GCs drafts for workspaces the snapshot no longer lists', () => {
    const { setChatDraft, syncChatDrafts } = useUiStore.getState()
    setChatDraft('live', 'acp-1', 'still typing')
    setChatDraft('live', 'acp-2', 'also typing')
    setChatDraft('gone', 'acp-1', 'orphaned')
    syncChatDrafts(['live'])
    expect(useUiStore.getState().chatDrafts).toEqual({
      [chatDraftKey('live', 'acp-1')]: { text: 'still typing' },
      [chatDraftKey('live', 'acp-2')]: { text: 'also typing' },
    })
  })

  it('keeps every draft when nothing is stale', () => {
    const { setChatDraft, syncChatDrafts } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'a')
    const before = useUiStore.getState().chatDrafts
    syncChatDrafts(['w1', 'w2'])
    expect(useUiStore.getState().chatDrafts).toBe(before)
  })
})

describe('persistSelection', () => {
  it('writes localStorage and mirrors into the URL query', () => {
    persistSelection('proj', 'sess')
    expect(JSON.parse(localStorage.getItem('yaac.selection.v1')!)).toEqual({
      projectSlug: 'proj', workspaceId: 'sess',
    })
    const params = new URLSearchParams(window.location.search)
    expect(params.get('project')).toBe('proj')
    expect(params.get('workspace')).toBe('sess')
  })

  it('drops the query params (and stores nulls) when both values are null', () => {
    persistSelection('proj', 'sess')
    persistSelection(null, null)
    expect(window.location.search).toBe('')
    expect(JSON.parse(localStorage.getItem('yaac.selection.v1')!)).toEqual({
      projectSlug: null, workspaceId: null,
    })
  })

  it('keeps the project but clears the workspace when only the workspace is null', () => {
    persistSelection('proj', 'sess')
    persistSelection('proj', null)
    const params = new URLSearchParams(window.location.search)
    expect(params.get('project')).toBe('proj')
    expect(params.has('workspace')).toBe(false)
  })

  it('preserves unrelated query params such as token', () => {
    window.history.replaceState({}, '', '/?token=abc')
    persistSelection('proj', 'sess')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('token')).toBe('abc')
    expect(params.get('project')).toBe('proj')
    expect(params.get('workspace')).toBe('sess')
  })

  it('is a no-op without localStorage', () => {
    const real = globalThis.localStorage
    // Simulate a browser that denies storage access.
    delete (globalThis as Record<string, unknown>).localStorage
    expect(() => persistSelection('proj', 'sess')).not.toThrow()
    // The URL is still mirrored even when storage is unavailable.
    expect(new URLSearchParams(window.location.search).get('project')).toBe('proj')
    ;(globalThis as Record<string, unknown>).localStorage = real
  })
})

describe('loadSelection', () => {
  it('reads the URL query first, ignoring localStorage', () => {
    window.history.replaceState({}, '', '/?project=urlproj&workspace=urlsess')
    localStorage.setItem('yaac.selection.v1', JSON.stringify({
      projectSlug: 'lsproj', workspaceId: 'lssess',
    }))
    expect(loadSelection()).toEqual({ projectSlug: 'urlproj', workspaceId: 'urlsess' })
  })

  it('treats a URL project with no workspace as a null workspace', () => {
    window.history.replaceState({}, '', '/?project=urlproj')
    expect(loadSelection()).toEqual({ projectSlug: 'urlproj', workspaceId: null })
  })

  it('falls back to localStorage when the URL has no project', () => {
    localStorage.setItem('yaac.selection.v1', JSON.stringify({
      projectSlug: 'lsproj', workspaceId: 'lssess',
    }))
    expect(loadSelection()).toEqual({ projectSlug: 'lsproj', workspaceId: 'lssess' })
  })

  it('returns nulls when nothing is persisted', () => {
    expect(loadSelection()).toEqual({ projectSlug: null, workspaceId: null })
  })

  it('survives malformed or partial localStorage', () => {
    localStorage.setItem('yaac.selection.v1', '{{{')
    expect(loadSelection()).toEqual({ projectSlug: null, workspaceId: null })
    localStorage.setItem('yaac.selection.v1', JSON.stringify({ projectSlug: 'p' }))
    expect(loadSelection()).toEqual({ projectSlug: 'p', workspaceId: null })
    localStorage.setItem('yaac.selection.v1', '"a string"')
    expect(loadSelection()).toEqual({ projectSlug: null, workspaceId: null })
  })

  it('round-trips through persistSelection', () => {
    persistSelection('proj', 'sess')
    // A bare reload (no URL params) should restore from localStorage.
    window.history.replaceState({}, '', '/')
    expect(loadSelection()).toEqual({ projectSlug: 'proj', workspaceId: 'sess' })
  })
})
