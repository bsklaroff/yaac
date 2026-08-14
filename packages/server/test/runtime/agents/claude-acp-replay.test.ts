import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { readClaudeTranscriptAsAcp } from '#runtime/agents/claude-acp-replay'

/**
 * A tui claude conversation read as ACP events.
 *
 * The assertions are deliberately about *what a reader sees* rather than about
 * a mapping table: this module writes none of the translation — the pinned
 * `claude-agent-acp` does, through the same function its own `session/load`
 * calls — so pinning each field to a literal would be testing that package's
 * choices, and would break every time it improved a title. What is worth
 * holding is that a real transcript comes out as the conversation it was, that
 * the entries which are not conversation stay out, and that a file that is
 * missing or damaged costs nothing.
 */

const SESSION = '11111111-2222-3333-4444-555555555555'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

// Each test writes its own conversation, so the chain starts over with it.
beforeEach(() => { parent = null })

/** A transcript on disk, one JSON object per line as claude writes it. */
async function transcript(entries: unknown[], trailing = ''): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claude-replay-'))
  dirs.push(dir)
  const file = path.join(dir, `${SESSION}.jsonl`)
  await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + trailing)
  return file
}

/**
 * Entries thread themselves onto the one before, because that chain is the
 * transcript's real structure: claude links every turn to its parent, and the
 * SDK reader walks those links rather than the file order. A fixture with the
 * links left out reads as a conversation of one message.
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

describe('readClaudeTranscriptAsAcp', () => {
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

    const events = await readClaudeTranscriptAsAcp(file, SESSION)

    // The shape of the conversation: what was asked, what was thought, what
    // was said, the tool that ran, and the plan it kept.
    expect(events.map((e) => e.type))
      .toEqual(['user', 'thought', 'agent', 'tool', 'tool', 'plan', 'agent'])
    // Sequence numbers are the projection's, and a pane orders by them.
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])

    const [ask, thought, said] = events
    expect(ask.type === 'user' && ask.content).toEqual([{ type: 'text', text: 'add a health route' }])
    expect(thought.type === 'thought' && thought.content[0])
      .toEqual({ type: 'text', text: 'The router is the place.' })
    expect(said.type === 'agent' && said.content[0])
      .toEqual({ type: 'text', text: 'Looking at the router.' })

    // The tool call is emitted, then completed by its result — the pane
    // collapses the pair onto the latest state, so the last one must carry
    // both the call's identity and its outcome.
    const calls = events.filter((e) => e.type === 'tool').map((e) => e.call)
    expect(calls[0].toolCallId).toBe('tu_1')
    expect(calls[0].kind).toBe('read')
    expect(calls[0].title).toContain('router.ts')
    expect(calls[1].toolCallId).toBe('tu_1')
    expect(calls[1].status).toBe('completed')
    expect(JSON.stringify(calls[1].content)).toContain('export const router = 1')

    // TodoWrite is a plan to a reader, not a tool row.
    const plan = events.find((e) => e.type === 'plan')
    expect(plan?.type === 'plan' && plan.entries.map((p) => [p.content, p.status])).toEqual([
      ['read the router', 'completed'],
      ['add the route', 'in_progress'],
    ])
  })

  it('leaves out the entries that are bookkeeping rather than conversation', async () => {
    const file = await transcript([
      // A slash command persists three synthetic user entries; none of them is
      // something a person said.
      user('<local-command-caveat>Caveat: …</local-command-caveat>', { isMeta: true }),
      user('<command-name>model</command-name>'),
      user('<local-command-stdout>Set model to Opus</local-command-stdout>'),
      { type: 'summary', summary: 'A conversation about routers', leafUuid: 'uuid-1' },
      user('the real question'),
      // claude's synthetic auth message stays in a transcript forever; a
      // replay that rendered it would resurface a stale login prompt.
      assistant([{ type: 'text', text: 'Not logged in · Please run /login' }], {
        message: {
          role: 'assistant', model: '<synthetic>',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      }),
      assistant([{ type: 'text', text: 'the real answer' }]),
    ])

    const events = await readClaudeTranscriptAsAcp(file, SESSION)

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
      // The pod died mid-tool: a call with no result. Truthful is better than
      // tidy — the conversation really did stop here.
      assistant([
        { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'sleep 100', description: 'wait' } },
      ]),
    ])

    const calls = (await readClaudeTranscriptAsAcp(file, SESSION))
      .filter((e) => e.type === 'tool').map((e) => e.call)

    expect(calls.find((c) => c.toolCallId === 'tu_1' && c.status === 'failed')).toBeDefined()
    const dangling = calls.filter((c) => c.toolCallId === 'tu_2')
    expect(dangling).toHaveLength(1)
    expect(dangling[0].status === 'completed' || dangling[0].status === 'failed').toBe(false)
  })

  it('answers empty for a transcript that is missing, empty, or unparseable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claude-replay-'))
    dirs.push(dir)

    // A conversation whose agent never wrote anything is an empty history,
    // not a failure — the same verdict `readAcpLog` reaches.
    expect(await readClaudeTranscriptAsAcp(path.join(dir, 'gone.jsonl'), SESSION)).toEqual([])

    const empty = path.join(dir, 'empty.jsonl')
    await fs.writeFile(empty, '')
    expect(await readClaudeTranscriptAsAcp(empty, SESSION)).toEqual([])

    const junk = path.join(dir, 'junk.jsonl')
    await fs.writeFile(junk, 'not json at all\n{"half": \n')
    expect(await readClaudeTranscriptAsAcp(junk, SESSION)).toEqual([])
  })

  it('tolerates a transcript still being appended to', async () => {
    // A read can land mid-write, so the last line is routinely a fragment.
    // Losing it must not cost the turns that completed before it.
    const file = await transcript(
      [user('a question'), assistant([{ type: 'text', text: 'an answer' }])],
      '{"type":"assistant","uuid":"uuid-9","mes',
    )
    expect((await readClaudeTranscriptAsAcp(file, SESSION)).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })

  it('reads a conversation whose id is not the shape the SDK validates', async () => {
    // Every recorded claude conversation id is a UUID, so this is a guard on a
    // malformed row — but answering with an empty history would hide it.
    const file = await transcript([
      user('still readable'),
      assistant([{ type: 'text', text: 'indeed' }]),
    ])
    expect((await readClaudeTranscriptAsAcp(file, 'not-a-uuid')).map((e) => e.type))
      .toEqual(['user', 'agent'])
  })
})

describe('the pinned adapter', () => {
  it('is the same version the worktree image installs', async () => {
    // The two translations must be one. A live acp conversation is recorded by
    // the adapter baked into the tools image; a stopped tui one is replayed by
    // the copy the server imports. Same function, same version — otherwise the
    // transcript a user reads after stopping a worktree can differ from what
    // they watched, which is the whole failure this module exists to avoid.
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
