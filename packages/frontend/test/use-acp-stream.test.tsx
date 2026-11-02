import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAcpStream } from '#lib/acp'
import type { AcpEvent, AcpQueuedPrompt, AcpServerMessage } from '@yaac/shared/acp'
import { agentEvent as agent, FakeSocket } from './harness'

/**
 * The chat pane's transport state machine: attach, replay, busy tracking and
 * reconnect. A bug here can merge two conversations on reconnect. The global
 * `WebSocket` is stubbed, since everything below it belongs to the browser.
 */

const hello = (events: AcpEvent[], busy = false, queued: AcpQueuedPrompt[] = [], page = 0): AcpServerMessage => ({
  type: 'hello',
  conversationId: 'acp-1',
  busy,
  queued,
  page,
  events,
})

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAcpStream', () => {
  it('holds one socket for as long as it is mounted, and drops it on unmount', async () => {
    // An off-screen pane stays mounted and keeps its connection, so switching
    // back is free. The socket must not outlive the pane, and an unmount must
    // not be mistaken for a drop and reconnected.
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([]))
    })
    expect(FakeSocket.instances).toHaveLength(1)

    const sock = FakeSocket.latest()
    unmount()
    expect(sock.readyState).toBe(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('addresses the conversation by workspace and session id', () => {
    renderHook(() => useAcpStream('wt-1', 'acp-1'))
    expect(FakeSocket.latest().url).toContain('id=wt-1')
    expect(FakeSocket.latest().url).toContain('session=acp-1')
  })

  it('renders the replayed history and reports connected', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([agent(0, 'earlier')]))
    })

    await waitFor(() => expect(result.current.connected).toBe(true))
    expect(result.current.events.map((e) => e.seq)).toEqual([0])
  })

  it('replaces its list on every hello, since the record is renumbered per attach', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([agent(0, 'a')]))
      FakeSocket.latest().deliver({ type: 'event', event: agent(1, 'b') })
    })
    await waitFor(() => expect(result.current.events).toHaveLength(2))

    // A re-read of the record, renumbered from zero.
    act(() => {
      FakeSocket.latest().deliver(hello([agent(0, 'a'), agent(1, 'b'), agent(2, 'c')]))
    })
    await waitFor(() => expect(result.current.events).toHaveLength(3))
    expect(result.current.events.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('discards a stale list when the record it re-reads is shorter', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([agent(0, 'old one'), agent(1, 'old two')]))
    })
    await waitFor(() => expect(result.current.events).toHaveLength(2))

    // acpd truncated its record and a new agent process is being recorded.
    // Merging would interleave two conversations into one transcript.
    act(() => {
      FakeSocket.latest().deliver(hello([agent(0, 'new one')]))
    })
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    expect(result.current.events[0]).toMatchObject({ content: [{ text: 'new one' }] })
  })

  it('tracks busy across a turn, and clears it on an error', async () => {
    // Only the server's explicit turn boundaries change busy. `turn-start`
    // also covers turns the pane could not infer, such as one already running
    // when the server reattached to the agent.
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([]))
    })

    act(() => FakeSocket.latest().deliver({ type: 'event', event: { type: 'turn-start', seq: 0 } }))
    await waitFor(() => expect(result.current.busy).toBe(true))

    act(() => FakeSocket.latest().deliver({
      type: 'event',
      event: { type: 'turn-end', seq: 1, stopReason: 'end_turn' },
    }))
    await waitFor(() => expect(result.current.busy).toBe(false))

    // An error also ends the turn, or a failed turn would spin forever.
    act(() => FakeSocket.latest().deliver({ type: 'event', event: { type: 'turn-start', seq: 2 } }))
    await waitFor(() => expect(result.current.busy).toBe(true))
    act(() => FakeSocket.latest().deliver({
      type: 'event',
      event: { type: 'error', seq: 3, message: 'boom' },
    }))
    await waitFor(() => expect(result.current.busy).toBe(false))
  })

  it('stays idle through a replayed conversation, which carries no turn boundaries', async () => {
    // After a restart, `session/load` re-emits the whole conversation as live
    // updates, so past user messages arrive like fresh ones. Turn boundaries
    // are never recorded, so treating a `user` event as a turn start would
    // leave the pane stuck at `working…`.
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([]))
    })

    act(() => {
      FakeSocket.latest().deliver({
        type: 'event',
        event: { type: 'user', seq: 0, content: [{ type: 'text', text: 'the old ask' }] },
      })
      FakeSocket.latest().deliver({ type: 'event', event: agent(1, 'the old answer') })
      FakeSocket.latest().deliver({
        type: 'event',
        event: { type: 'user', seq: 2, content: [{ type: 'text', text: 'and another' }] },
      })
      FakeSocket.latest().deliver({ type: 'event', event: agent(3, 'and its answer') })
    })

    await waitFor(() => expect(result.current.events).toHaveLength(4))
    expect(result.current.busy).toBe(false)

    // And the conversation is live again the moment a real turn starts.
    act(() => FakeSocket.latest().deliver({ type: 'event', event: { type: 'turn-start', seq: 4 } }))
    await waitFor(() => expect(result.current.busy).toBe(true))
  })

  it('adopts the busy state the server reports on attach', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([], true))
    })
    // Attaching mid-turn must show the agent working, not idle.
    await waitFor(() => expect(result.current.busy).toBe(true))
  })

  it('shows the messages queued behind the turn, from attach and as they change', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    const waiting = { id: 'q1', text: 'then this', images: 0 }
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([], true, [waiting]))
    })
    // A pane attaching mid-turn sees what another tab queued.
    await waitFor(() => expect(result.current.queued).toEqual([waiting]))

    act(() => FakeSocket.latest().deliver({ type: 'queue', queued: [] }))
    await waitFor(() => expect(result.current.queued).toEqual([]))
  })

  it('greys out on a health frame without tearing the pane down', async () => {
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([agent(0, 'a')]))
    })
    await waitFor(() => expect(result.current.connected).toBe(true))

    act(() => FakeSocket.latest().deliver({ type: 'health', connected: false }))
    await waitFor(() => expect(result.current.connected).toBe(false))
    // Only the connection went away; the conversation stays on screen.
    expect(result.current.events).toHaveLength(1)
  })

  it('reports a socket the server closed without greeting as refused, and a dropped attach as not', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    const next = async (): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    }
    // One that never opened is a failed dial, not a refusal.
    act(() => FakeSocket.latest().close())
    await next()
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([]))
      FakeSocket.latest().close()
    })
    expect(result.current.refused).toBe(false)
    await next()

    // The server's hold ran out with no conversation.
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver({ type: 'health', connected: false })
      FakeSocket.latest().close()
    })
    expect(result.current.refused).toBe(true)
  })

  it('reconnects after the socket closes', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([]))
    })
    expect(result.current.connected).toBe(true)

    act(() => FakeSocket.latest().close())
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
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([]))
    })
    await waitFor(() => expect(result.current.connected).toBe(true))

    expect(result.current.send({ type: 'prompt', text: 'now' })).toBe(true)
    expect(JSON.parse(FakeSocket.latest().sent[0])).toEqual({ type: 'prompt', text: 'now' })
  })

  it('surfaces the user echo that tells a pane its message was received', async () => {
    // A socket write does not prove the server got the message. The pane
    // waits for the `user` event echo before it clears the input.
    const { result } = renderHook(() => useAcpStream('wt-1', 'acp-1'))
    act(() => {
      FakeSocket.latest().open()
      FakeSocket.latest().deliver(hello([]))
    })
    expect(result.current.send({ type: 'prompt', text: 'ship it' })).toBe(true)
    expect(result.current.events).toHaveLength(0)

    act(() => FakeSocket.latest().deliver({
      type: 'event',
      event: { type: 'user', seq: 0, content: [{ type: 'text', text: 'ship it' }] },
    }))
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    expect(result.current.events[0]).toMatchObject({ content: [{ text: 'ship it' }] })
  })
})
