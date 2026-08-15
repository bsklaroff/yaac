// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAcpStream } from '#lib/acp'
import type { AcpEvent, AcpServerMessage } from '@yaac/shared/acp'

/**
 * The chat pane's transport state machine — attach, replay, busy tracking,
 * reconnect. It is hand-rolled and it decides whether a reconnect shows the
 * conversation or a corrupted merge of two, so it is worth driving rather
 * than trusting.
 *
 * The socket is stubbed at the global, which is the real boundary: everything
 * below `WebSocket` is the browser's, everything above is the code under test.
 */

/** A WebSocket the test opens, feeds and closes by hand. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  readyState = 0
  sent: string[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  /** Complete the handshake the hook is waiting on. */
  open(): void {
    this.readyState = 1
  }

  /** Deliver a server frame. */
  deliver(msg: AcpServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

const hello = (events: AcpEvent[], busy = false): AcpServerMessage => ({
  type: 'hello',
  agentSessionId: 'acp-1',
  busy,
  events,
})

const agent = (seq: number, text: string): AcpEvent =>
  ({ type: 'agent', seq, content: [{ type: 'text', text }] })

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]

describe('useAcpStream', () => {
  it('holds one socket for as long as it is mounted, and drops it on unmount', async () => {
    // Mounting is the gate: an off-screen pane stays mounted and keeps its
    // connection, so a switch back costs nothing. What must not happen is a
    // socket outliving the pane, or an unmount being mistaken for a drop and
    // reconnected — a closed pane would then hold a connection forever.
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([]))
    })
    expect(FakeSocket.instances).toHaveLength(1)

    const sock = latest()
    unmount()
    expect(sock.readyState).toBe(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('opens no socket for a conversation that has no id yet', () => {
    // A worktree whose agent has not minted a session id is addressed by
    // nothing; dialling would attach to whatever answers to the empty string.
    renderHook(() => useAcpStream('wt-1', ''))
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('addresses the conversation by worktree and session id', () => {
    renderHook(() => useAcpStream('wt-1', 'acp-1'))
    expect(latest().url).toContain('id=wt-1')
    expect(latest().url).toContain('session=acp-1')
  })

  it('renders the replayed history and reports connected', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([agent(0, 'earlier')]))
    })

    await waitFor(() => expect(result.current.connected).toBe(true))
    expect(result.current.events.map((e) => e.seq)).toEqual([0])
  })

  it('replaces its list on every hello, since the record is renumbered per attach', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([agent(0, 'a')]))
      latest().deliver({ type: 'event', event: agent(1, 'b') })
    })
    await waitFor(() => expect(result.current.events).toHaveLength(2))

    // A re-read of the record, renumbered from zero.
    act(() => {
      latest().deliver(hello([agent(0, 'a'), agent(1, 'b'), agent(2, 'c')]))
    })
    await waitFor(() => expect(result.current.events).toHaveLength(3))
    expect(result.current.events.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('discards a stale list when the record it re-reads is shorter', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([agent(0, 'old one'), agent(1, 'old two')]))
    })
    await waitFor(() => expect(result.current.events).toHaveLength(2))

    // acpd truncated and a new agent life is being recorded. Merging would
    // leave the old life's events stranded behind the new one's, interleaving
    // two conversations into a transcript that never existed.
    act(() => {
      latest().deliver(hello([agent(0, 'new one')]))
    })
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    expect(result.current.events[0]).toMatchObject({ content: [{ text: 'new one' }] })
  })

  it('tracks busy across a turn, and clears it on an error', async () => {
    // Only the server's explicit boundaries move this. `turn-start` covers the
    // turns the pane cannot infer as well as the ones it could: a turn already
    // running when the server reattached to the agent was sent by nobody here.
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([]))
    })

    act(() => latest().deliver({ type: 'event', event: { type: 'turn-start', seq: 0 } }))
    await waitFor(() => expect(result.current.busy).toBe(true))

    act(() => latest().deliver({
      type: 'event',
      event: { type: 'turn-end', seq: 1, stopReason: 'end_turn' },
    }))
    await waitFor(() => expect(result.current.busy).toBe(false))

    // An error ends the turn too — otherwise a failed turn spins forever.
    act(() => latest().deliver({ type: 'event', event: { type: 'turn-start', seq: 2 } }))
    await waitFor(() => expect(result.current.busy).toBe(true))
    act(() => latest().deliver({
      type: 'event',
      event: { type: 'error', seq: 3, message: 'boom' },
    }))
    await waitFor(() => expect(result.current.busy).toBe(false))
  })

  it('stays idle through a replayed conversation, which carries no turn boundaries', async () => {
    // What a restart looks like from here: `session/load` re-emits the whole
    // conversation as live updates, so past user messages arrive one at a time
    // exactly as a fresh one would. Nothing closes them — boundaries describe
    // what is happening now and are never recorded — so a pane that read a
    // `user` event as "a turn began" would sit at `working…` for good, offering
    // a Stop button with no turn behind it.
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([]))
    })

    act(() => {
      latest().deliver({
        type: 'event',
        event: { type: 'user', seq: 0, content: [{ type: 'text', text: 'the old ask' }] },
      })
      latest().deliver({ type: 'event', event: agent(1, 'the old answer') })
      latest().deliver({
        type: 'event',
        event: { type: 'user', seq: 2, content: [{ type: 'text', text: 'and another' }] },
      })
      latest().deliver({ type: 'event', event: agent(3, 'and its answer') })
    })

    await waitFor(() => expect(result.current.events).toHaveLength(4))
    expect(result.current.busy).toBe(false)

    // And the conversation is live again the moment a real turn starts.
    act(() => latest().deliver({ type: 'event', event: { type: 'turn-start', seq: 4 } }))
    await waitFor(() => expect(result.current.busy).toBe(true))
  })

  it('adopts the busy state the server reports on attach', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([], true))
    })
    // Attaching mid-turn must show the agent working, not idle.
    await waitFor(() => expect(result.current.busy).toBe(true))
  })

  it('greys out on a health frame without tearing the pane down', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([agent(0, 'a')]))
    })
    await waitFor(() => expect(result.current.connected).toBe(true))

    act(() => latest().deliver({ type: 'health', connected: false }))
    await waitFor(() => expect(result.current.connected).toBe(false))
    // The conversation is still on screen — only the connection went away.
    expect(result.current.events).toHaveLength(1)
  })

  it('reconnects after the socket closes', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([]))
    })
    expect(result.current.connected).toBe(true)

    act(() => latest().close())
    expect(result.current.connected).toBe(false)

    const before = FakeSocket.instances.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(FakeSocket.instances.length).toBeGreaterThan(before)
  })

  it('reports whether a send reached the socket, so a dropped message is not silently cleared', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    // Not open yet: the caller must be able to keep the user's text.
    expect(result.current.send({ type: 'prompt', text: 'early' })).toBe(false)

    act(() => {
      latest().open()
      latest().deliver(hello([]))
    })
    await waitFor(() => expect(result.current.connected).toBe(true))

    expect(result.current.send({ type: 'prompt', text: 'now' })).toBe(true)
    expect(JSON.parse(latest().sent[0])).toEqual({ type: 'prompt', text: 'now' })
  })

  it('surfaces the user echo that tells a pane its message was received', async () => {
    // Writing to a socket is not evidence the server got anything. The
    // conversation echoing the message back as a `user` event is, and that is
    // what the pane waits for before it clears the box.
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([]))
    })
    expect(result.current.send({ type: 'prompt', text: 'ship it' })).toBe(true)
    expect(result.current.events).toHaveLength(0)

    act(() => latest().deliver({
      type: 'event',
      event: { type: 'user', seq: 0, content: [{ type: 'text', text: 'ship it' }] },
    }))
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    expect(result.current.events[0]).toMatchObject({ content: [{ text: 'ship it' }] })
  })

  it('ignores a malformed frame rather than dropping the conversation', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      latest().open()
      latest().deliver(hello([agent(0, 'a')]))
    })
    await waitFor(() => expect(result.current.events).toHaveLength(1))

    act(() => latest().onmessage?.({ data: 'not json at all' }))
    act(() => latest().onmessage?.({ data: new ArrayBuffer(4) }))
    expect(result.current.events).toHaveLength(1)
    expect(result.current.connected).toBe(true)
  })
})
