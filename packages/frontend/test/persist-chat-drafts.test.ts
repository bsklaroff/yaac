import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chatDraftKey,
  flushChatDrafts,
  loadChatDrafts,
  persistChatDrafts,
  useUiStore,
} from '#store'

/**
 * Half-typed ACP messages outlive their pane, which is torn down every time it
 * goes off-screen. This covers the two ways that can go wrong: the map growing
 * forever as worktrees come and go, and a reload finding garbage where a draft
 * should be — plus the `sent` marker, which is what lets a restored draft be
 * told apart from a message that was already delivered.
 */

// Minimal localStorage stand-in for the node test environment.
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  }
  return store
}

describe('chat-draft persistence', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = stubLocalStorage()
    useUiStore.setState({ chatDrafts: {} })
  })

  afterEach(() => {
    // Also clears the debounce timer, so no write lands after teardown.
    flushChatDrafts()
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('round-trips drafts, with and without an in-flight message', () => {
    persistChatDrafts({
      'w1|acp-1': { text: 'half a thought' },
      'w2|acp-9': { text: 'sent, unconfirmed', sent: 'sent, unconfirmed' },
    })
    expect(loadChatDrafts()).toEqual({
      'w1|acp-1': { text: 'half a thought' },
      'w2|acp-9': { text: 'sent, unconfirmed', sent: 'sent, unconfirmed' },
    })
  })

  it('survives garbage, absence, and values that are not drafts', () => {
    expect(loadChatDrafts()).toEqual({})
    store.set('yaac.chatdrafts.v1', '{{{')
    expect(loadChatDrafts()).toEqual({})
    store.set('yaac.chatdrafts.v1', '["a", "b"]')
    expect(loadChatDrafts()).toEqual({})
    store.set('yaac.chatdrafts.v1', JSON.stringify({
      a: { text: 'keep' },
      b: 'a bare string',
      c: { text: 42 },
      d: { text: 'bad marker', sent: 7 },
      e: { text: '' },
      f: null,
    }))
    expect(loadChatDrafts()).toEqual({ a: { text: 'keep' } })
  })

  it('keeps an oversized paste in memory but out of localStorage', () => {
    // One giant draft must not exhaust the quota and take the other keys'
    // writes down with it — the whole map is one JSON blob.
    const huge = 'x'.repeat(64 * 1024 + 1)
    persistChatDrafts({ 'w1|acp-1': { text: huge }, 'w2|acp-1': { text: 'small' } })
    expect(loadChatDrafts()).toEqual({ 'w2|acp-1': { text: 'small' } })
  })

  it('writes drafts through the store, keyed per conversation', () => {
    const { setChatDraft } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'first conversation')
    setChatDraft('w1', 'acp-2', 'second conversation')
    flushChatDrafts()
    expect(loadChatDrafts()).toEqual({
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
    expect(loadChatDrafts()).toEqual({})
  })

  it('records what went to the socket, and forgets it once settled', () => {
    const { setChatDraft, setChatSent } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'ship it')
    setChatSent('w1', 'acp-1', 'ship it')
    expect(useUiStore.getState().chatDrafts).toEqual({
      [chatDraftKey('w1', 'acp-1')]: { text: 'ship it', sent: 'ship it' },
    })
    // The echo settles both: nothing typed, nothing in flight, no key.
    setChatDraft('w1', 'acp-1', '')
    setChatSent('w1', 'acp-1', undefined)
    expect(useUiStore.getState().chatDrafts).toEqual({})
  })

  it('drops the marker when the text is edited', () => {
    // Whatever is in the box now is new work — it is no longer the message
    // that went to the socket, so it must not be mistaken for it later.
    const { setChatDraft, setChatSent } = useUiStore.getState()
    setChatDraft('w1', 'acp-1', 'ok')
    setChatSent('w1', 'acp-1', 'ok')
    setChatDraft('w1', 'acp-1', 'ok, and one more thing')
    expect(useUiStore.getState().chatDrafts).toEqual({
      [chatDraftKey('w1', 'acp-1')]: { text: 'ok, and one more thing' },
    })
  })

  it('settles the marker when the box is emptied, leaving no key', () => {
    // The box only empties through the echo, which is the same moment the
    // marker stops meaning anything — so the whole entry goes, rather than a
    // marker outliving the text it described.
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

  it('GCs drafts for worktrees the snapshot no longer lists', () => {
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
