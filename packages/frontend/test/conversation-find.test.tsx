// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { AcpEvent } from '@yaac/shared/acp'
import type { AgentSessionEntry } from '@yaac/shared/types'
import { ReadOnlyTranscript } from '#components/ReadOnlyTranscript'
import { TuiTranscriptSearch } from '#components/TuiTranscriptSearch'
import { countMatches, type QuerySpec } from '#lib/matchCount'
import { IS_MAC } from '#lib/platform'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, testQueryClient } from './harness'

/**
 * Cmd/Ctrl-F over a conversation (`useConversationFind`), driven through the
 * panes that offer it: a stopped workspace's transcript and a running `tui`
 * agent's pane. The server is answered at `fetch` and the count runs in a
 * fake Worker, so what is asserted is what the reader sees: the count, and
 * the rows a match opens.
 */

/** jsdom has no Worker. This one runs the real `countMatches` a tick later. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  postMessage(msg: { id: number; doc: string; spec: QuerySpec }): void {
    setTimeout(() => this.onmessage?.({ data: { id: msg.id, matches: countMatches(msg.doc, msg.spec) } } as MessageEvent), 0)
  }
  terminate(): void {}
}

const TRANSCRIPT = 'GET /api/workspace/w1/agent-sessions/c1/transcript'

const session = (over: Partial<AgentSessionEntry> = {}): AgentSessionEntry => ({
  agentSessionId: 'c1', tool: 'claude', mode: 'tui', ordinal: 0, active: true, ...over,
})

/** One needle in each of: an agent message, a thought (hidden until opened),
 *  and a shell call's output (hidden until opened). */
const EVENTS: AcpEvent[] = [
  { type: 'user', seq: 0, content: [{ type: 'text', text: 'find the bug' }] },
  { type: 'thought', seq: 1, content: [{ type: 'text', text: 'maybe a needle here' }] },
  {
    type: 'tool', seq: 2,
    call: { toolCallId: 't1', title: 'grep -r bug', kind: 'execute', status: 'completed', shell: true },
  },
  { type: 'tool-output', seq: 3, toolCallId: 't1', data: 'src/a.ts: needle\n' },
  { type: 'agent', seq: 4, content: [{ type: 'text', text: 'Found the needle.' }] },
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('Worker', FakeWorker)
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  mockFetch({ [TRANSCRIPT]: { events: EVENTS } })
  // Every step shown: these cases are about rows, not folded runs.
  useUiStore.setState({ chatCondensed: false })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Let both counting passes land; each step is its own act so the effects
 *  a step's results start get to run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(100) })
}
const pressFind = (): void => {
  fireEvent.keyDown(document.body, { code: 'KeyF', key: 'f', ctrlKey: !IS_MAC, metaKey: IS_MAC })
}
const find = (): HTMLInputElement => screen.getByRole<HTMLInputElement>('textbox', { name: 'Find' })
const status = (): string => screen.getByRole('status').textContent ?? ''

describe('ReadOnlyTranscript', () => {
  it('finds text the rows hide, steps through it, and keeps the current match open on close', async () => {
    renderWithClient(<ReadOnlyTranscript workspaceId="w1" sessions={[session()]} />)
    await settle()
    expect(screen.queryByText('src/a.ts: needle')).toBeNull()

    pressFind()
    expect(document.activeElement).toBe(find())
    fireEvent.change(find(), { target: { value: 'needle' } })
    await settle()
    // The thought and the call's output open to show their matches.
    expect(status()).toBe('1 of 3')
    expect(screen.getByText('maybe a needle here')).toBeTruthy()
    expect(screen.getByText('src/a.ts: needle')).toBeTruthy()

    fireEvent.keyDown(find(), { key: 'Enter' })
    expect(status()).toBe('2 of 3')
    fireEvent.keyDown(find(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(find(), { key: 'Enter', shiftKey: true })
    expect(status()).toBe('3 of 3')

    fireEvent.change(find(), { target: { value: 'nope' } })
    await settle()
    expect(status()).toBe('No results')
    expect(screen.queryByText('src/a.ts: needle')).toBeNull()

    // Closing on the call's match leaves only that row open.
    fireEvent.change(find(), { target: { value: 'needle' } })
    await settle()
    fireEvent.keyDown(find(), { key: 'Enter' })
    expect(status()).toBe('2 of 3')
    fireEvent.keyDown(find(), { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    expect(screen.getByText('src/a.ts: needle')).toBeTruthy()
    expect(screen.queryByText('maybe a needle here')).toBeNull()
  })

  it('never overrides what the reader opened or closed', async () => {
    renderWithClient(<ReadOnlyTranscript workspaceId="w1" sessions={[session()]} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Thinking/ }))
    expect(screen.getByText('maybe a needle here')).toBeTruthy()

    pressFind()
    fireEvent.change(find(), { target: { value: 'needle' } })
    await settle()
    // A row a match holds open can still be closed while searching.
    fireEvent.click(screen.getByRole('button', { name: /grep -r bug/ }))
    expect(screen.queryByText('src/a.ts: needle')).toBeNull()
    await settle()
    expect(status()).toBe('1 of 2')

    // Closing on the last match leaves the thought as the reader left it.
    fireEvent.keyDown(find(), { key: 'Enter', shiftKey: true })
    expect(status()).toBe('2 of 2')
    fireEvent.keyDown(find(), { key: 'Escape' })
    await settle()
    expect(screen.getByText('maybe a needle here')).toBeTruthy()
    expect(screen.queryByText('src/a.ts: needle')).toBeNull()
  })
})

describe('TuiTranscriptSearch', () => {
  it('lays the conversation over the focused terminal on Cmd/Ctrl-F, and Escape returns to it', async () => {
    const sessions = [session(), session({ agentSessionId: 'a1', mode: 'acp', ordinal: 1 })]
    const client = testQueryClient()
    const { rerender } = renderWithClient(<TuiTranscriptSearch workspaceId="w1" sessions={sessions} visible focused={false} />, client)
    pressFind()
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()

    rerender(
      <QueryClientProvider client={client}>
        <TuiTranscriptSearch workspaceId="w1" sessions={sessions} visible focused />
      </QueryClientProvider>,
    )
    pressFind()
    await settle()
    expect(document.activeElement).toBe(find())
    // Only the terminal's conversation: no picker for the chat one.
    expect(screen.getByText('Found the needle.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Conversation/ })).toBeNull()

    fireEvent.change(find(), { target: { value: 'needle' } })
    await settle()
    expect(status()).toBe('1 of 3')

    fireEvent.keyDown(find(), { key: 'Escape' })
    expect(screen.queryByText('Found the needle.')).toBeNull()
    expect(useUiStore.getState().activeTabs.w1).toBe('agent')

    // A pane that leaves the screen drops the overlay, and with it the
    // transcript's refresh.
    pressFind()
    await settle()
    expect(screen.getByText('Found the needle.')).toBeTruthy()
    rerender(
      <QueryClientProvider client={client}>
        <TuiTranscriptSearch workspaceId="w1" sessions={sessions} visible={false} focused={false} />
      </QueryClientProvider>,
    )
    expect(screen.queryByText('Found the needle.')).toBeNull()
  })
})
