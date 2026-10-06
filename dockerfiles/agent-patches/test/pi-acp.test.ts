import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { patchPiAcp } from '../pi-acp.js'

/**
 * Runs the pinned pi-acp, patched, against a scripted stand-in for
 * `pi --mode rpc` (via pi-acp's `PI_ACP_PI_COMMAND`), and drives it over
 * ACP as yaac's server does.
 */

const require = createRequire(import.meta.url)
const PI_ACP = path.dirname(require.resolve('pi-acp/package.json'))

/**
 * The pi stand-in. A prompt's run streams `run:<message>`, then delivers
 * any queued steers as `steer:<text>` (as pi does before its next model
 * call), then ends. Like pi, it awaits `SETTLE_DELAY_MS` between ending and
 * reporting `agent_settled`; a steer arriving then stays queued.
 *
 * The prompt `bash` instead runs one bash call whose partial results are
 * snapshots as pi takes them: the whole output until it passes the tail
 * window (4 lines here, 2000 in pi), then the latest window without its
 * trailing newline, slid by one line, by two, and past line 8, which no
 * snapshot shows.
 */
const FAKE_PI = `#!/usr/bin/env node
const SETTLE_DELAY_MS = 400
const queue = []
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const text = (delta) => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const LINES = Array.from({ length: 12 }, (_, i) => 'line-' + (i + 1))
const whole = (n) => ({ content: [{ type: 'text', text: LINES.slice(0, n).map((l) => l + '\\n').join('') }] })
const window = (n) => ({ content: [{ type: 'text', text: LINES.slice(n - 4, n).join('\\n') }] })
function bash() {
  const call = { toolCallId: 'call_1', toolName: 'bash', args: { command: 'tail-window' } }
  out({ type: 'agent_start' })
  out({ type: 'tool_execution_start', ...call })
  for (const partialResult of [whole(1), whole(4), window(4), window(5), window(7)]) {
    out({ type: 'tool_execution_update', ...call, partialResult })
  }
  out({ type: 'tool_execution_end', ...call, result: window(12), isError: false })
  out({ type: 'agent_end' })
  out({ type: 'agent_settled' })
}
async function run(message) {
  out({ type: 'agent_start' })
  text('run:' + message + ';')
  await wait(400)
  while (queue.length > 0) text('steer:' + queue.shift() + ';')
  out({ type: 'agent_end' })
  await wait(SETTLE_DELAY_MS)
  out({ type: 'agent_settled' })
}
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const cmd = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    const reply = (data) => out({ type: 'response', id: cmd.id, command: cmd.type, success: true, data })
    if (cmd.type === 'prompt') { reply(); if (cmd.message === 'bash') bash(); else void run(cmd.message) }
    else if (cmd.type === 'steer') { queue.push(cmd.message); reply() }
    else if (cmd.type === 'clear_queue') reply({ steering: queue.splice(0), followUp: [] })
    else if (cmd.type === 'get_available_models') reply({ models: [{ provider: 'fake', id: 'fake', name: 'fake' }] })
    else if (cmd.type === 'get_commands') reply({ commands: [] })
    else if (cmd.type === 'get_available_thinking_levels') reply({ levels: ['off'] })
    else if (cmd.type === 'get_messages') reply({ messages: [] })
    else if (cmd.type === 'get_state') reply({ thinkingLevel: 'off' })
    else reply({})
  }
})
`

let dir: string
let adapter: ChildProcess
let nextId = 1
const replies = new Map<number, (msg: { result?: Record<string, unknown> }) => void>()
let agentText = ''
let terminalOutput = ''
const log: string[] = []

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-pi-acp-'))
  // The patched copy resolves pi-acp's own dependencies from its install.
  fs.mkdirSync(path.join(dir, 'pi-acp', 'dist'), { recursive: true })
  fs.copyFileSync(path.join(PI_ACP, 'package.json'), path.join(dir, 'pi-acp', 'package.json'))
  fs.symlinkSync(path.dirname(fs.realpathSync(PI_ACP)), path.join(dir, 'pi-acp', 'node_modules'))
  const source = fs.readFileSync(path.join(PI_ACP, 'dist', 'index.js'), 'utf8')
  fs.writeFileSync(path.join(dir, 'pi-acp', 'dist', 'index.js'), patchPiAcp(source))
  fs.writeFileSync(path.join(dir, 'pi'), FAKE_PI, { mode: 0o755 })
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
  terminalOutput = ''
  log.length = 0
  adapter = spawn(process.execPath, [path.join(dir, 'pi-acp', 'dist', 'index.js')], {
    cwd: dir,
    env: { ...process.env, PI_ACP_PI_COMMAND: path.join(dir, 'pi'), PI_CODING_AGENT_DIR: dir },
  })
  let buf = ''
  adapter.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, i)) as {
        id?: number
        method?: string
        result?: Record<string, unknown>
        params?: {
          update?: { sessionUpdate?: string; content?: { text?: string }; _meta?: { terminal_output?: { data: string } } }
        }
      }
      buf = buf.slice(i + 1)
      if (msg.method === undefined && msg.id !== undefined) {
        log.push(`reply ${msg.id}`)
        replies.get(msg.id)?.(msg)
      }
      const update = msg.params?.update
      terminalOutput += update?._meta?.terminal_output?.data ?? ''
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text?.includes(':')) {
        agentText += update.content.text
        log.push(update.content.text)
      }
    }
  })
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  expect(init.result?._meta).toEqual({ steering: { supported: true } })
  const session = await request('session/new', { cwd: dir, mcpServers: [] })
  if (session.result === undefined) throw new Error(`session/new failed: ${JSON.stringify(session)}`)
  return session.result.sessionId as string
}

const steer = (sessionId: string, text: string): Promise<{ result?: Record<string, unknown> }> =>
  request('_session/steering', {
    sessionId,
    prompt: [{ type: 'text', text }],
    _meta: { steering: { idleBehavior: 'promptRequired' } },
  })

const until = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out; saw ${JSON.stringify(log)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('patchPiAcp', () => {
  it('lets a message join the running turn, and hands one back when nothing runs', async () => {
    const sessionId = await start()
    expect((await steer(sessionId, 'too early')).result).toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' })

    const turn = request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await until(() => agentText.includes('run:first;'))
    expect((await steer(sessionId, 'and this')).result).toEqual({ outcome: 'injected' })

    // Delivered inside the turn, which then ends with a single reply.
    expect((await turn).result).toEqual({ stopReason: 'end_turn' })
    expect(agentText).toBe('run:first;steer:and this;')
  })

  it('continues the turn with a steer pi accepted after its last check, instead of stranding it', async () => {
    const sessionId = await start()
    const turn = request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    let replied = false
    void turn.then(() => { replied = true })
    // After the run's last queue check, before it reports settled.
    await until(() => agentText.includes('run:first;'))
    await new Promise((r) => setTimeout(r, 600))
    expect((await steer(sessionId, 'just in time')).result).toEqual({ outcome: 'injected' })

    // The same turn runs again with it, and only then replies.
    await until(() => agentText.includes('run:just in time;'))
    expect(replied).toBe(false)
    expect((await turn).result).toEqual({ stopReason: 'end_turn' })
  })

  it('sends a bash call\'s output as appends, each line once, past pi\'s tail window', async () => {
    const sessionId = await start()
    const turn = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'bash' }] })
    expect(turn.result).toEqual({ stopReason: 'end_turn' })
    const lines = Array.from({ length: 12 }, (_, i) => `line-${String(i + 1)}`)
    expect(terminalOutput).toBe(lines.filter((l) => l !== 'line-8').join('\n'))
  })

  it('is tested against the release the image installs', () => {
    const dockerfile = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'Dockerfile.tools'), 'utf8')
    const installed = /npm install -g --ignore-scripts pi-acp@(\S+)/.exec(dockerfile)?.[1]
    expect(installed).toBe((JSON.parse(fs.readFileSync(path.join(PI_ACP, 'package.json'), 'utf8')) as { version: string }).version)
  })

  it('refuses a release whose code it no longer recognizes, rather than skipping an edit', () => {
    expect(() => patchPiAcp('#!/usr/bin/env node\nconsole.log(1)\n')).toThrow(/anchor .* is missing/)
  })

  it('leaves an already patched file alone', () => {
    const source = fs.readFileSync(path.join(PI_ACP, 'dist', 'index.js'), 'utf8')
    const once = patchPiAcp(source)
    expect(patchPiAcp(once)).toBe(once)
  })
})
