import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { patchClaudeAgentAcp } from '../claude-agent-acp.js'

/**
 * Runs the pinned claude-agent-acp, patched, against a scripted stand-in for
 * the claude CLI (via the adapter's `CLAUDE_CODE_EXECUTABLE`), and drives it
 * over ACP as yaac's server does.
 */

const require = createRequire(import.meta.url)
const ADAPTER = path.dirname(require.resolve('@agentclientprotocol/claude-agent-acp/package.json'))

/**
 * The claude stand-in, speaking the SDK's stream-json. A message runs one
 * cycle: `running`, its echo, `answer:<message>;`, a result naming it, then
 * `idle`. After the message `background` a finished background task wakes
 * it into a run of its own (`woke;`). A message arriving during that run is
 * consumed by it, as the CLI does, and the run's result carries the run's
 * own `task-notification` origin while naming that message.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { randomUUID } = require('node:crypto')
if (process.argv[2] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n')
  process.exit(0)
}
const session = (process.argv.find((a) => a.startsWith('--session-id=')) ?? '').slice('--session-id='.length)
const INIT = { commands: [], models: [{ value: 'default', displayName: 'Default', description: '' }], account: { subscriptionType: 'max' } }
const out = (m) => process.stdout.write(JSON.stringify({ session_id: session, ...m }) + '\\n')
const state = (s) => out({ type: 'system', subtype: 'session_state_changed', state: s, uuid: randomUUID() })
const say = (text) => out({
  type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null,
  message: { id: randomUUID(), role: 'assistant', model: 'fake', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
})
const result = (kind, uuid) => out({
  type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', num_turns: 1,
  duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, modelUsage: {}, permission_denials: [],
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  uuid: randomUUID(), origin: { kind }, ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
})
const textOf = (m) => m.message.content.map((c) => c.text).join('')
let takeIntoRun
async function onUser(m) {
  if (takeIntoRun) return takeIntoRun(m)
  state('running')
  out({ ...m, origin: { kind: 'human' } })
  say('answer:' + textOf(m) + ';')
  result('human', m.uuid)
  state('idle')
  if (textOf(m) !== 'background') return
  await new Promise((r) => setTimeout(r, 200))
  state('running')
  say('woke;')
  const folded = await new Promise((resolve) => { takeIntoRun = resolve; setTimeout(resolve, 1000) })
  takeIntoRun = undefined
  if (folded) {
    out({ ...folded, origin: { kind: 'human' } })
    say('answer:' + textOf(folded) + ';')
  }
  result('task-notification', folded?.uuid)
  state('idle')
}
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const m = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (m.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: m.request.subtype === 'initialize' ? INIT : {} } })
    }
    if (m.type === 'user') void onUser(m)
  }
})
`

let dir: string
let adapter: ChildProcess
let nextId = 1
const replies = new Map<number, (msg: { result?: Record<string, unknown> }) => void>()
let agentText = ''

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-claude-agent-acp-'))
  // The patched copy resolves the adapter's own dependencies from its install.
  const copy = path.join(dir, 'claude-agent-acp')
  fs.cpSync(path.join(ADAPTER, 'dist'), path.join(copy, 'dist'), { recursive: true })
  fs.copyFileSync(path.join(ADAPTER, 'package.json'), path.join(copy, 'package.json'))
  fs.symlinkSync(path.dirname(path.dirname(fs.realpathSync(ADAPTER))), path.join(copy, 'node_modules'))
  const agent = path.join(copy, 'dist', 'acp-agent.js')
  fs.writeFileSync(agent, patchClaudeAgentAcp(fs.readFileSync(agent, 'utf8')))
  fs.writeFileSync(path.join(dir, 'claude'), FAKE_CLAUDE, { mode: 0o755 })
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

afterEach(() => adapter.kill())

function request(method: string, params: unknown): Promise<{ result?: Record<string, unknown> }> {
  const id = nextId++
  adapter.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve) => replies.set(id, resolve))
}

/** Start the patched adapter and open a session; returns its id. */
async function start(): Promise<string> {
  agentText = ''
  adapter = spawn(process.execPath, [path.join(dir, 'claude-agent-acp', 'dist', 'index.js')], {
    cwd: dir,
    // HOME too, so the adapter reads no real settings.
    env: { ...process.env, CLAUDE_CODE_EXECUTABLE: path.join(dir, 'claude'), HOME: dir },
  })
  let buf = ''
  adapter.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, i)) as {
        id?: number
        method?: string
        result?: Record<string, unknown>
        params?: { update?: { sessionUpdate?: string; content?: { text?: string } } }
      }
      buf = buf.slice(i + 1)
      if (msg.method === undefined && msg.id !== undefined) replies.get(msg.id)?.(msg)
      const update = msg.params?.update
      // Only the stand-in's own text: the adapter adds notices of its own.
      const own = update?.sessionUpdate === 'agent_message_chunk' ? update.content?.text?.match(/(answer:[^;]*|woke);/g) : null
      if (own) agentText += own.join('')
    }
  })
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const session = await request('session/new', { cwd: dir, mcpServers: [] })
  if (session.result === undefined) throw new Error(`session/new failed: ${JSON.stringify(session)}`)
  return session.result.sessionId as string
}

const prompt = (sessionId: string, text: string): Promise<{ result?: Record<string, unknown> }> =>
  request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })

const until = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out; saw ${agentText}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('patchClaudeAgentAcp', () => {
  it('answers a prompt the agent folds into a run it woke itself into, and only that one', async () => {
    const sessionId = await start()
    expect((await prompt(sessionId, 'background')).result).toMatchObject({ stopReason: 'end_turn' })

    // A run that takes in no prompt stays the agent's own.
    await until(() => agentText.includes('woke;'))
    await new Promise((r) => setTimeout(r, 1200))
    expect((await prompt(sessionId, 'next')).result).toMatchObject({ stopReason: 'end_turn' })

    // A message sent during such a run is handed back as a steer, goes as a
    // prompt, and is answered once the run that consumed it ends.
    expect((await prompt(sessionId, 'background')).result).toMatchObject({ stopReason: 'end_turn' })
    await until(() => agentText.split('woke;').length === 3)
    const steer = await request('_session/steering', {
      sessionId,
      prompt: [{ type: 'text', text: 'late' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    })
    expect(steer.result).toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' })
    const late = await Promise.race([
      prompt(sessionId, 'late'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the folded prompt was never answered')), 5000)),
    ])
    expect(late.result).toMatchObject({ stopReason: 'end_turn' })
    expect(agentText).toBe('answer:background;woke;answer:next;answer:background;woke;answer:late;')
  })

  it('is tested against the release the image installs', () => {
    const dockerfile = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'Dockerfile.tools'), 'utf8')
    const installed = /npm install -g @agentclientprotocol\/claude-agent-acp@(\S+)/.exec(dockerfile)?.[1]
    expect(installed).toBe((JSON.parse(fs.readFileSync(path.join(ADAPTER, 'package.json'), 'utf8')) as { version: string }).version)
  })

  it('refuses a release whose code it no longer recognizes, rather than skipping an edit', () => {
    expect(() => patchClaudeAgentAcp('console.log(1)\n')).toThrow(/anchor .* is missing/)
  })

  it('leaves an already patched file alone', () => {
    const source = fs.readFileSync(path.join(ADAPTER, 'dist', 'acp-agent.js'), 'utf8')
    const once = patchClaudeAgentAcp(source)
    expect(patchClaudeAgentAcp(once)).toBe(once)
  })
})
