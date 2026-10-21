import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordAgentSessions } from '#db/agent-session-store'
import { closeDb } from '#db/client'
import { claudeDir } from '@yaac/shared/project-paths'
import { observeConversation, stopHistoryTails } from '#domain/workspaces/history-tail'
import type { AcpServerMessage } from '@yaac/shared/acp'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'

/**
 * A reader following a running conversation over `/acp/observe`. A `tui`
 * one is followed through claude's own transcript on disk, written here as
 * claude writes it, so the tail, the translation and its cache all run for
 * real.
 */

const PROJECT = '7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d'
const WORKSPACE = 'wt-1'
const TUI_SESSION = '22222222-2222-2222-2222-222222222222'
const ACP_SESSION = '11111111-1111-1111-1111-111111111111'

let tmpDir: string

beforeEach(async () => {
  installFakeWorkspaceDriver()
  tmpDir = await createTempDataDir()
  await recordWorkspaceCreated({ projectId: PROJECT, workspaceId: WORKSPACE })
  await recordAgentSessions(PROJECT, WORKSPACE, [
    { tool: 'claude', agentSessionId: TUI_SESSION, mode: 'tui' },
    { tool: 'claude', agentSessionId: ACP_SESSION, mode: 'acp' },
  ])
})

afterEach(async () => {
  stopHistoryTails()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A reader's socket the test reads back. */
class FakeSocket {
  sent: AcpServerMessage[] = []
  closedWith: string | undefined
  private messageCb: ((data: Buffer, isBinary: boolean) => void) | null = null
  private readonly closeCbs: Array<() => void> = []
  send(data: string): void { this.sent.push(JSON.parse(data) as AcpServerMessage) }
  close(_code?: number, reason?: string): void { this.closedWith = reason }
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void { this.messageCb = cb }
  onClose(cb: () => void): void { this.closeCbs.push(cb) }
  clientSend(msg: unknown): void { this.messageCb?.(Buffer.from(JSON.stringify(msg)), false) }
  clientClose(): void { for (const cb of this.closeCbs) cb() }
  /** The text of every `user` and `agent` event, as the reader holds them. */
  said(): string[] {
    let events: Extract<AcpServerMessage, { type: 'hello' }>['events'] = []
    for (const m of this.sent) {
      if (m.type === 'hello') events = m.events
      if (m.type === 'event') events = [...events, m.event]
    }
    return events.flatMap((e) => (e.type === 'user' || e.type === 'agent'
      ? e.content.flatMap((c) => (c.type === 'text' ? [c.text] : []))
      : []))
  }
  hellos(): number {
    return this.sent.filter((m) => m.type === 'hello').length
  }
}

async function waitFor(cond: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(cond()).toBe(true), { timeout: 5000, interval: 20 })
}

const transcriptDir = (): string => path.join(claudeDir(PROJECT), 'projects', '-workspace')
const transcriptFile = (): string => path.join(transcriptDir(), `${TUI_SESSION}.jsonl`)

let parent: string | null = null
function entry(uuid: string, type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}): string {
  const line = JSON.stringify({
    type, uuid, parentUuid: parent, sessionId: TUI_SESSION, cwd: '/workspace', timestamp: '2026-01-01T00:00:00Z',
    message: type === 'user' ? { role: type, content } : { role: type, model: 'claude-fable-5', content },
    ...extra,
  })
  parent = uuid
  return `${line}\n`
}

describe('observeConversation', () => {
  it('follows a tui conversation for every reader, sending each what claude appended', async () => {
    parent = null
    await fs.mkdir(transcriptDir(), { recursive: true })
    const agent = (id: string, prompt: string): unknown[] => [{ type: 'tool_use', id, name: 'Agent', input: { description: prompt, prompt } }]
    await fs.writeFile(transcriptFile(), entry('u1', 'user', 'count the files')
      + entry('a1', 'assistant', agent('toolu_count', 'Count the files'))
      + entry('a1b', 'assistant', agent('toolu_other', 'Something else')))

    const a = new FakeSocket()
    const b = new FakeSocket()
    await observeConversation(PROJECT, WORKSPACE, TUI_SESSION, a)
    await observeConversation(PROJECT, WORKSPACE, TUI_SESSION, b)
    for (const sock of [a, b]) {
      await waitFor(() => sock.hellos() === 1)
      expect(sock.sent[0]).toMatchObject({ type: 'hello', history: true, busy: false, agentSessionId: TUI_SESSION })
      expect(sock.said()).toEqual(['count the files'])
    }

    // A subagent's transcript is sent to every reader following it when
    // asked, and again as it grows.
    const subagents = path.join(transcriptDir(), TUI_SESSION, 'subagents')
    await fs.mkdir(subagents, { recursive: true })
    const sub = (agentId: string, uuid: string, parentUuid: string | null, type: 'user' | 'assistant', content: unknown): string => `${JSON.stringify({
      type, uuid, parentUuid, isSidechain: true, agentId, sessionId: TUI_SESSION, cwd: '/workspace', timestamp: '2026-01-01T00:00:00Z',
      message: type === 'user' ? { role: type, content } : { role: type, model: 'claude-fable-5', content },
    })}\n`
    for (const [agentId, toolUseId, prompt] of [['x1', 'toolu_count', 'Count the files'], ['x2', 'toolu_other', 'Something else']]) {
      await fs.writeFile(path.join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId }))
      await fs.writeFile(path.join(subagents, `agent-${agentId}.jsonl`), sub(agentId, `${agentId}-1`, null, 'user', prompt))
    }
    const grow = (text: string): Promise<void> =>
      fs.appendFile(path.join(subagents, 'agent-x1.jsonl'), sub('x1', `x1-${text}`, 'x1-1', 'assistant', [{ type: 'text', text }]))
    const threads = (sock: FakeSocket): AcpServerMessage[] => sock.sent.filter((m) => m.type === 'subagent-transcript')
    a.clientSend({ type: 'subagent-transcript', subagentId: 'toolu_count' })
    a.clientSend({ type: 'subagent-transcript', subagentId: '../../etc/passwd' })
    b.clientSend({ type: 'subagent-transcript', subagentId: 'toolu_count' })
    await waitFor(() => threads(a).length === 2 && threads(b).length === 1)
    expect(threads(a)).toEqual(expect.arrayContaining([
      { type: 'subagent-transcript', subagentId: 'toolu_count', events: [] },
      { type: 'subagent-transcript', subagentId: '../../etc/passwd', error: 'no such subagent' },
    ]))
    await grow('There are 12.')
    for (const sock of [a, b]) await waitFor(() => JSON.stringify(threads(sock).at(-1)).includes('There are 12.'))

    // A reader that opens another subagent no longer follows the first.
    a.clientSend({ type: 'subagent-transcript', subagentId: 'toolu_other' })
    await waitFor(() => threads(a).at(-1)?.type === 'subagent-transcript' && JSON.stringify(threads(a).at(-1)).includes('toolu_other'))
    await grow('Make that 13.')
    await waitFor(() => JSON.stringify(threads(b).at(-1)).includes('Make that 13.'))
    expect(JSON.stringify(threads(a))).not.toContain('Make that 13.')

    // What claude appends reaches both readers as events after the greeting.
    await fs.appendFile(transcriptFile(), entry('r1', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_count', content: '12' }])
      + entry('a2', 'assistant', [{ type: 'text', text: 'There are 12 files.' }]))
    for (const sock of [a, b]) {
      await waitFor(() => sock.said().includes('There are 12 files.'))
      expect(sock.hellos()).toBe(1)
      expect(sock.sent.some((m) => m.type === 'event')).toBe(true)
    }

    // A reader that leaves is sent nothing more.
    b.clientClose()
    const left = b.sent.length
    // A `/rewind` writes the next prompt under an earlier message, so what
    // was sent no longer stands: the readers still there are greeted again.
    parent = 'a2'
    await fs.appendFile(transcriptFile(), entry('u3', 'user', 'thanks'))
    await waitFor(() => a.said().includes('thanks'))
    parent = 'u1'
    await fs.appendFile(transcriptFile(), entry('a9', 'assistant', [{ type: 'text', text: 'a different answer' }]))
    await waitFor(() => a.hellos() === 2)
    expect(a.said()).toEqual(['count the files', 'a different answer'])
    expect(b.sent.length).toBe(left)
  })

  it('refuses a conversation the workspace never had, and an acp one with nothing live to follow', async () => {
    const unknown = new FakeSocket()
    await observeConversation(PROJECT, WORKSPACE, '33333333-3333-3333-3333-333333333333', unknown)
    expect(unknown.sent).toEqual([{ type: 'health', connected: false }])
    expect(unknown.closedWith).toBe('no such conversation')

    // An acp conversation is the chat bridge's, which closes a socket when
    // no agent is connected, as it does an owner's pane.
    const acp = new FakeSocket()
    await observeConversation(PROJECT, WORKSPACE, ACP_SESSION, acp)
    expect(acp.sent).toEqual([{ type: 'health', connected: false }])
    expect(acp.closedWith).toBe('no live conversation')
  })
})
