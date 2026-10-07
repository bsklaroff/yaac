import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { claudeSubagentThreads, claudeTranscriptAsAcp } from '#runtime/agents/claude-acp-replay'

/**
 * A tui claude conversation replayed as ACP events. The translation is done
 * by the pinned `claude-agent-acp`, so these tests check the overall
 * conversation rather than exact field values: real turns come through,
 * non-conversation entries stay out, and a missing or damaged file is
 * harmless.
 */

const SESSION = '11111111-2222-3333-4444-555555555555'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

beforeEach(() => { parent = null })

/** A transcript file, one JSON object per line. */
async function transcript(entries: unknown[], trailing = ''): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claude-replay-'))
  dirs.push(dir)
  const file = path.join(dir, `${SESSION}.jsonl`)
  await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + trailing)
  return file
}

/**
 * Each entry links to the previous one as its parent, as claude writes
 * them; the SDK follows those links rather than file order.
 */
let uuid = 0
let parent: string | null = null
const nextUuid = (): string => `uuid-${String(++uuid)}`

function turn(
  type: 'user' | 'assistant',
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): unknown {
  const id = nextUuid()
  const entry = {
    type, uuid: id, parentUuid: parent, sessionId: SESSION, cwd: '/workspace',
    timestamp: '2026-01-01T00:00:00Z', message, ...extra,
  }
  parent = id
  return entry
}

function user(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return turn('user', { role: 'user', content }, extra)
}

function assistant(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return turn('assistant', { role: 'assistant', model: 'claude-fable-5', content }, extra)
}

describe('claudeTranscriptAsAcp', () => {
  it('replays a conversation as the events an acp pane renders', async () => {
    const file = await transcript([
      user('add a health route'),
      assistant([
        { type: 'thinking', thinking: 'The router is the place.', signature: 'sig' },
        { type: 'text', text: 'Looking at the router.' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/workspace/router.ts' } },
      ]),
      user([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'export const router = 1\n' }]),
      assistant([{ type: 'tool_use', id: 'tu_2', name: 'TodoWrite', input: { todos: [
        { content: 'read the router', status: 'completed', activeForm: 'Reading' },
        { content: 'add the route', status: 'in_progress', activeForm: 'Adding' },
      ] } }]),
      assistant([{ type: 'text', text: 'Added it.' }]),
    ])

    const events = await claudeTranscriptAsAcp(await fs.readFile(file, 'utf8'), SESSION)

    expect(events.map((e) => e.type))
      .toEqual(['user', 'thought', 'agent', 'tool', 'tool', 'plan', 'agent'])
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])

    const [ask, thought, said] = events
    expect(ask.type === 'user' && ask.content).toEqual([{ type: 'text', text: 'add a health route' }])
    expect(thought.type === 'thought' && thought.content[0])
      .toEqual({ type: 'text', text: 'The router is the place.' })
    expect(said.type === 'agent' && said.content[0])
      .toEqual({ type: 'text', text: 'Looking at the router.' })

    // The pane keeps only the latest update per call, so the last one must
    // carry both the call and its result.
    const calls = events.filter((e) => e.type === 'tool').map((e) => e.call)
    expect(calls[0].toolCallId).toBe('tu_1')
    expect(calls[0].kind).toBe('read')
    expect(calls[0].title).toContain('router.ts')
    expect(calls[1].toolCallId).toBe('tu_1')
    expect(calls[1].status).toBe('completed')
    expect(JSON.stringify(calls[1].content)).toContain('export const router = 1')

    // TodoWrite becomes a plan; the current step shows its `activeForm`.
    const plan = events.find((e) => e.type === 'plan')
    expect(plan?.type === 'plan' && plan.entries.map((p) => [p.content, p.status])).toEqual([
      ['read the router', 'completed'],
      ['Adding', 'in_progress'],
    ])
  })

  it('leaves out the entries that are bookkeeping rather than conversation', async () => {
    const file = await transcript([
      // The three synthetic user entries a slash command writes.
      user('<local-command-caveat>Caveat: …</local-command-caveat>', { isMeta: true }),
      user('<command-name>model</command-name>'),
      user('<local-command-stdout>Set model to Opus</local-command-stdout>'),
      { type: 'summary', summary: 'A conversation about routers', leafUuid: 'uuid-1' },
      user('the real question'),
      // claude's synthetic login message, which must not be replayed.
      assistant([{ type: 'text', text: 'Not logged in · Please run /login' }], {
        message: {
          role: 'assistant', model: '<synthetic>',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      }),
      assistant([{ type: 'text', text: 'the real answer' }]),
    ])

    const events = await claudeTranscriptAsAcp(await fs.readFile(file, 'utf8'), SESSION)

    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
    const [ask, said] = events
    expect(ask.type === 'user' && ask.content).toEqual([{ type: 'text', text: 'the real question' }])
    expect(said.type === 'agent' && said.content).toEqual([{ type: 'text', text: 'the real answer' }])
  })

  it('reports a failed tool call as failed, and leaves an unanswered one running', async () => {
    const file = await transcript([
      user('run the tests'),
      assistant([
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'false', description: 'run tests' } },
      ]),
      user([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'exit 1', is_error: true }]),
      // The pod died mid-tool: a call with no result.
      assistant([
        { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'sleep 100', description: 'wait' } },
      ]),
    ])

    const calls = (await claudeTranscriptAsAcp(await fs.readFile(file, 'utf8'), SESSION))
      .filter((e) => e.type === 'tool').map((e) => e.call)

    expect(calls.find((c) => c.toolCallId === 'tu_1' && c.status === 'failed')).toBeDefined()
    const dangling = calls.filter((c) => c.toolCallId === 'tu_2')
    expect(dangling).toHaveLength(1)
    expect(dangling[0].status === 'completed' || dangling[0].status === 'failed').toBe(false)
  })

  it('answers empty for a transcript that is empty or unparseable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claude-replay-'))
    dirs.push(dir)

    const empty = path.join(dir, 'empty.jsonl')
    await fs.writeFile(empty, '')
    expect(await claudeTranscriptAsAcp(await fs.readFile(empty, 'utf8'), SESSION)).toEqual([])

    const junk = path.join(dir, 'junk.jsonl')
    await fs.writeFile(junk, 'not json at all\n{"half": \n')
    expect(await claudeTranscriptAsAcp(await fs.readFile(junk, 'utf8'), SESSION)).toEqual([])
  })

  it('tolerates a transcript still being appended to', async () => {
    // The last line may be half-written.
    const file = await transcript(
      [user('a question'), assistant([{ type: 'text', text: 'an answer' }])],
      '{"type":"assistant","uuid":"uuid-9","mes',
    )
    expect((await claudeTranscriptAsAcp(await fs.readFile(file, 'utf8'), SESSION)).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('reads a conversation whose id is not the shape the SDK validates', async () => {
    // Guards against a malformed row; an empty history would hide it.
    const file = await transcript([
      user('still readable'),
      assistant([{ type: 'text', text: 'indeed' }]),
    ])
    expect((await claudeTranscriptAsAcp(await fs.readFile(file, 'utf8'), 'not-a-uuid')).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })
})

describe('claudeSubagentThreads', () => {
  it('reads the subagents Agent calls launched from the transcripts claude keeps beside the session', async () => {
    const dir = path.dirname(await transcript([user('count the files')]))
    const subagents = path.join(dir, SESSION, 'subagents')
    await fs.mkdir(subagents, { recursive: true })
    // As claude writes them: a meta file naming the call, and the subagent's
    // own conversation, every entry a sidechain.
    const subagent = async (agentId: string, toolUseId: string, entries: (extra: Record<string, unknown>) => unknown[]): Promise<void> => {
      parent = null
      await fs.writeFile(path.join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId }))
      const lines = entries({ isSidechain: true, agentId }).map((e) => JSON.stringify(e))
      await fs.writeFile(path.join(subagents, `agent-${agentId}.jsonl`), lines.join('\n') + '\n')
    }
    await subagent('a1', 'toolu_count', (extra) => [
      user('Count the files in src', extra),
      assistant([{ type: 'tool_use', id: 'tu_ls', name: 'Bash', input: { command: 'ls src | wc -l' } }], extra),
      user([{ type: 'tool_result', tool_use_id: 'tu_ls', content: '12' }], extra),
      assistant([{ type: 'text', text: 'There are 12 files.' }], extra),
    ])
    await subagent('a2', 'toolu_other', (extra) => [user('Something else', extra), assistant([{ type: 'text', text: 'Done.' }], extra)])
    // Parallel calls, as claude writes them: one entry per call sharing the
    // message id, with the chain going on from the first call's result, so a
    // parent walk back from the leaf alone would skip the second call.
    await subagent('a3', 'toolu_parallel', (extra) => {
      const at = (uuid: string, parentUuid: string | null, type: 'user' | 'assistant', message: Record<string, unknown>): unknown => ({
        type, uuid, parentUuid, sessionId: SESSION, cwd: '/workspace', timestamp: '2026-01-01T00:00:00Z', ...extra,
        message: type === 'assistant' ? { role: type, model: 'claude-fable-5', ...message } : { role: type, ...message },
      })
      return [
        at('p1', null, 'user', { content: 'List the root and count hostname lines' }),
        at('p2', 'p1', 'assistant', { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_a', name: 'Bash', input: { command: 'ls /' } }] }),
        at('p3', 'p2', 'assistant', { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'wc -l /etc/hostname' } }] }),
        at('p4', 'p3', 'user', { content: [{ type: 'tool_result', tool_use_id: 'tu_b', content: '1 /etc/hostname' }] }),
        at('p5', 'p2', 'user', { content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'bin etc' }] }),
        at('p6', 'p5', 'assistant', { id: 'msg_2', content: [{ type: 'text', text: 'Two calls done.' }] }),
      ]
    })
    // A meta too large to read, sorted first, is skipped rather than failing
    // the rest.
    await fs.writeFile(path.join(subagents, 'agent-0big.meta.json'), 'x'.repeat(65 * 1024))
    const session = { projectId: 'demo', dir, rel: `${SESSION}.jsonl` }
    const threads = (events: Awaited<ReturnType<typeof claudeSubagentThreads>>): unknown[] =>
      events.map((e) => [e.type, 'thread' in e ? e.thread : undefined])

    // Each thread in the order asked, without the prompt that opens it: the
    // view shows that as the subagent's task. Nothing for a call that
    // launched no subagent.
    const events = await claudeSubagentThreads(session, ['toolu_other', 'toolu_none', 'toolu_count'])
    expect(threads(events)).toEqual([
      ['agent', 'toolu_other'], ['tool', 'toolu_count'], ['tool', 'toolu_count'], ['agent', 'toolu_count'],
    ])
    expect(events.at(-1)).toMatchObject({ content: [{ type: 'text', text: 'There are 12 files.' }] })
    expect(events.some((e) => 'seq' in e)).toBe(false)

    // Read under one budget: a transcript that would go past it is left out.
    const first = (await fs.stat(path.join(subagents, 'agent-a2.jsonl'))).size
    expect(threads(await claudeSubagentThreads(session, ['toolu_other', 'toolu_count'], first + 10)))
      .toEqual([['agent', 'toolu_other']])

    // A subagent's parallel calls all come through.
    const parallel = await claudeSubagentThreads(session, ['toolu_parallel'])
    const calls = new Set(parallel.flatMap((e) => (e.type === 'tool' ? [e.call.toolCallId] : [])))
    expect([...calls].sort()).toEqual(['tu_a', 'tu_b'])
    expect(parallel.at(-1)).toMatchObject({ type: 'agent', content: [{ type: 'text', text: 'Two calls done.' }] })

    // Nothing for a session with no subagents.
    expect(await claudeSubagentThreads({ ...session, rel: 'other.jsonl' }, ['toolu_count'])).toEqual([])
  })
})

describe('the pinned adapter', () => {
  it('is the same version the workspace image installs', async () => {
    // Live acp conversations use the adapter in the tools image; replays use
    // the server's copy. Different versions could render them differently.
    const dockerfile = await fs.readFile(
      new URL('../../../../../dockerfiles/Dockerfile.tools', import.meta.url), 'utf8',
    )
    const pinned = /@agentclientprotocol\/claude-agent-acp@(\S+)/.exec(dockerfile)?.[1]
    const installed = (createRequire(import.meta.url)(
      '@agentclientprotocol/claude-agent-acp/package.json',
    ) as { version: string }).version
    expect(pinned).toBe(installed)
  })
})
