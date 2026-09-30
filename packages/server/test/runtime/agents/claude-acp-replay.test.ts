import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { claudeTranscriptAsAcp } from '#runtime/agents/claude-acp-replay'

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
