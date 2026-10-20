import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  agentTitlesItself,
  agentWindowName,
  getAgentSessionFirstMessage,
  getAgentSessionTitle,
  resolveAgentPermissionMode,
} from '#runtime/agents/agent-tools'
import { codexDir } from '@yaac/shared/project-paths'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import type { SandboxFile } from '#runtime/agents'
import type { WorkspaceDriver } from '#drivers/contract'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import type { AgentTool } from '@yaac/shared/types'

// Workspaces sandboxed, as under k8s; a test wanting containerless
// installs its own.
beforeEach(() => { installFakeWorkspaceDriver() })

describe('agentWindowName', () => {
  it("gives the workspace's first agent the bare tool name", () => {
    // `yaac:<tool>` targets depend on the first window being unsuffixed.
    expect(agentWindowName('claude', 0)).toBe('claude')
    expect(agentWindowName('codex', 0)).toBe('codex')
  })

  it('suffixes extra agents with their 1-based ordinal', () => {
    expect(agentWindowName('claude', 1)).toBe('claude-2')
    expect(agentWindowName('pi', 4)).toBe('pi-5')
  })
})

describe('getAgentSessionFirstMessage', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-first-msg-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  let n = 0
  /** A transcript holding `entries`, one JSON line each (strings verbatim). */
  async function transcript(entries: Array<Record<string, unknown> | string>): Promise<SandboxFile> {
    const rel = `t-${String(n++)}.jsonl`
    const lines = entries.map((e) => typeof e === 'string' ? e : JSON.stringify(e))
    await fs.writeFile(path.join(dir, rel), lines.map((l) => l + '\n').join(''))
    return { projectId: 'demo', dir, rel }
  }
  const user = (content: unknown, extra: object = {}) => ({ type: 'user', ...extra, message: { role: 'user', content } })
  const codexEvent = (payload: object) => ({ type: 'event_msg', payload })
  const codexBootstrap = (text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })
  const piMessage = (role: string, content: unknown) => ({ type: 'message', message: { role, content } })
  // Past the scanner's first read chunk.
  const BIG = 'x'.repeat(12000)

  const cases: Array<[string, AgentTool, Array<Record<string, unknown> | string>, string | undefined]> = [
    ['claude string content', 'claude',
      [{ type: 'permission-mode' }, user('fix the login bug'), { type: 'assistant' }, user('second')], 'fix the login bug'],
    ['claude text block', 'claude', [user([{ type: 'text', text: 'refactor the API' }])], 'refactor the API'],
    ['claude tool result skipped', 'claude',
      [user([{ type: 'tool_result', content: 'ok' }]), user('the real ask')], 'the real ask'],
    ['claude with no user message', 'claude', [{ type: 'permission-mode' }, { type: 'assistant' }], undefined],
    ['an empty transcript', 'claude', [], undefined],
    ['claude past the first chunk', 'claude', [{ type: 'system', content: BIG }, user('hello world')], 'hello world'],
    ['an unparseable line skipped', 'claude', ['{not-json', user('hello world')], 'hello world'],
    // What `/model` writes before the first real turn: an isMeta caveat, the
    // command, and its stdout.
    ['claude slash command skipped', 'claude', [
      user('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
      user('<command-name>/model</command-name>\n<command-message>model</command-message>'),
      user('<local-command-stdout>Set model to Fable 5</local-command-stdout>'),
      user('fix the login bug'),
    ], 'fix the login bug'],
    ['claude isMeta skipped', 'claude', [user('preamble', { isMeta: true }), user('real message')], 'real message'],
    ['claude only commands', 'claude',
      [user('<local-command-caveat>c</local-command-caveat>', { isMeta: true }), user('<command-name>/clear</command-name>')],
      undefined],
    ['codex user_message event', 'codex',
      [{ type: 'session_start' }, codexEvent({ type: 'user_message', message: 'fix the login bug' })], 'fix the login bug'],
    // As codex 0.163.0 writes it.
    ['codex completed UserMessage item', 'codex', [
      codexBootstrap('hello'),
      codexEvent({ type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'hi' }] } }),
      codexEvent({ type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'hello' }] } }),
    ], 'hello'],
    // Bootstrap response items (AGENTS.md) are not the user's prompt.
    ['codex bootstrap skipped, past the first chunk', 'codex', [
      { type: 'session_meta', payload: { base_instructions: { text: BIG } } },
      codexBootstrap('# AGENTS.md instructions for /workspace'),
      codexBootstrap('fix the login bug'),
      codexEvent({ type: 'user_message', message: 'fix the login bug' }),
    ], 'fix the login bug'],
    ['codex without a user event', 'codex', [
      { type: 'event_msg', message: 'legacy top-level shape' },
      codexEvent({ type: 'agent_message', message: 'internal note' }),
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    ], undefined],
    ['pi string content', 'pi',
      [{ type: 'session' }, piMessage('user', 'fix the login bug'), piMessage('assistant', 'on it')], 'fix the login bug'],
    ['pi text parts joined', 'pi',
      [piMessage('user', [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }])], 'hello world'],
    ['pi non-user entries skipped', 'pi',
      [{ type: 'tool', name: 'bash' }, piMessage('assistant', 'thinking'), piMessage('user', 'the real prompt')],
      'the real prompt'],
  ]

  it.each(cases)('reads %s', async (_name, tool, entries, expected) => {
    expect(await getAgentSessionFirstMessage(tool, await transcript(entries))).toBe(expected)
  })

  it('returns undefined without a recorded path, or for a missing file', async () => {
    // No lookup by id: a `/clear` conversation's id is not yaac's, and a
    // codex rollout's filename cannot be derived from one.
    for (const tool of ['claude', 'codex', 'pi'] as const) {
      await expect(getAgentSessionFirstMessage(tool, undefined)).resolves.toBeUndefined()
      await expect(getAgentSessionFirstMessage(tool, { projectId: 'demo', dir, rel: 'missing.jsonl' })).resolves.toBeUndefined()
    }
    // opencode keeps its history in a database, not a transcript.
    await expect(getAgentSessionFirstMessage('opencode', await transcript([user('hi')]))).resolves.toBeUndefined()
  })

  it('scans a line that never ends in time linear in its length', async () => {
    const file = await transcript(['x'.repeat(16 * 1024 * 1024), user('after')])
    const started = Date.now()
    expect(await getAgentSessionFirstMessage('claude', file)).toBe('after')
    expect(Date.now() - started).toBeLessThan(5000)
  })

})

describe('getAgentSessionTitle', () => {
  let dataDir: string
  beforeEach(async () => { dataDir = await createTempDataDir() })
  afterEach(async () => { await cleanupTempDir(dataDir) })

  const PROJECT = 'demo'
  const src = (agentSessionId: string, transcript?: SandboxFile) =>
    ({ projectId: PROJECT, agentSessionId, jobName: 'container', ...(transcript ? { transcript } : {}) })
  /** `lines` as a JSONL file under the data dir. */
  async function jsonl(rel: string, lines: Array<Record<string, unknown> | string>): Promise<SandboxFile> {
    const file = path.join(dataDir, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)) + '\n').join(''))
    return { projectId: PROJECT, dir: dataDir, rel }
  }
  const aiTitle = (t: string) => ({ type: 'ai-title', aiTitle: t, sessionId: 's1' })
  const customTitle = (t: string) => ({ type: 'custom-title', customTitle: t, sessionId: 's1' })
  const filler = (bytes: number) => ({ type: 'assistant', message: { content: 'x'.repeat(bytes) } })

  // claude re-appends its title records as it writes, so the latest sit
  // near the end; a rename (`custom-title`, also what the ACP adapter
  // stores) wins over the TUI's generated one.
  it("reads claude's title from its transcript's end, a rename over a generated title", async () => {
    const title = async (lines: Array<Record<string, unknown> | string>) =>
      getAgentSessionTitle('claude', src('s1', await jsonl(`t-${String(Math.random())}.jsonl`, lines)))

    expect(await title([{ type: 'user', message: { content: 'fix it' } }])).toBeUndefined()
    expect(await title([aiTitle('Old'), filler(100), aiTitle('Fix the login bug')])).toBe('Fix the login bug')
    expect(await title([aiTitle('Generated'), customTitle('Mine'), aiTitle('Generated again')])).toBe('Mine')
    // A partial line at the start of the read is skipped, not misparsed.
    expect(await title([filler(400 * 1024), filler(10), aiTitle('Late')])).toBe('Late')
    // One that scrolled out of the read is not found.
    expect(await title([aiTitle('Early'), filler(400 * 1024)])).toBeUndefined()
    // No transcript (an acp conversation not yet found), or none on disk.
    expect(await getAgentSessionTitle('claude', src('s1'))).toBeUndefined()
    expect(await getAgentSessionTitle('claude', src('s1', { projectId: PROJECT, dir: dataDir, rel: 'gone.jsonl' }))).toBeUndefined()
  })

  // Shared by the project's workspaces and append-only: the newest line for
  // the thread wins, and an empty name is a cleared one.
  it("reads codex's thread name from the project's session index", async () => {
    const index = path.relative(dataDir, path.join(codexDir(PROJECT), 'session_index.jsonl'))
    expect(await getAgentSessionTitle('codex', src('t-1'))).toBeUndefined()
    const entry = (id: string, name: string) => ({ id, thread_name: name, updated_at: '2026-10-20T00:00:00Z' })
    await jsonl(index, [entry('t-1', 'Fix login'), entry('t-2', 'Other thread'), entry('t-1', 'Fix login redirect'), entry('t-3', 'Named'), entry('t-3', ''), '{cut'])
    expect(await getAgentSessionTitle('codex', src('t-1'))).toBe('Fix login redirect')
    expect(await getAgentSessionTitle('codex', src('t-3'))).toBeUndefined()
    expect(await getAgentSessionTitle('codex', src('t-4'))).toBeUndefined()
  })

  // opencode has no host transcript: its title is probed in the running
  // workspace, by session id since `session.list` returns only the 50 most
  // recently updated.
  it('asks a live opencode workspace for the named session’s title only', async () => {
    const exec = vi.fn<WorkspaceDriver['exec']>((_job, cmd) => {
      const id = /sessionID=(\S+)$/.exec(cmd)?.[1]
      if (id === 'ses_titled') return Promise.resolve({ stdout: JSON.stringify({ data: { id, title: 'OLIVE' } }) + '\n', stderr: '' })
      // What opencode calls a session until it has generated a title.
      if (id === 'ses_new') {
        return Promise.resolve({ stdout: JSON.stringify({ data: { id, title: 'New session - 2026-10-20T11:22:33.456Z' } }), stderr: '' })
      }
      if (id === 'ses_untitled') return Promise.resolve({ stdout: JSON.stringify({ data: { id } }), stderr: '' })
      return Promise.reject(new Error('HTTP 404 Not Found'))
    })
    installFakeWorkspaceDriver({ exec })
    const title = (id: string) => getAgentSessionTitle('opencode', src(id))

    expect(await title('ses_titled')).toBe('OLIVE')
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(['container', 'opencode api --standalone session.get --param sessionID=ses_titled'])
    for (const id of ['ses_new', 'ses_untitled', 'ses_gone']) expect(await title(id)).toBeUndefined()
    // A workspace id or a malformed id never reaches the command line.
    exec.mockClear()
    for (const id of ['wt-1', 'ses_foo-bar']) expect(await title(id)).toBeUndefined()
    expect(exec).not.toHaveBeenCalled()
  })

  it('has no title for pi, which titles nothing', async () => {
    expect(await getAgentSessionTitle('pi', src('p-1', await jsonl('pi.jsonl', [aiTitle('Not pi')])))).toBeUndefined()
  })
})

describe('agentTitlesItself', () => {
  it('is every tool with a title store but pi', () => {
    expect(['claude', 'codex', 'opencode', 'pi'].map((t) => agentTitlesItself(t as AgentTool)))
      .toEqual([true, true, true, false])
  })
})

describe('resolveAgentPermissionMode', () => {
  // Each adapter's mode ids map back to postures; claude's `default` and
  // `dontAsk` both map to `manual`.
  it('reads an acp mode id back through the adapter it came from', () => {
    expect(resolveAgentPermissionMode('acp', 'claude', 'default', 'bypass')).toBe('manual')
    expect(resolveAgentPermissionMode('acp', 'claude', 'dontAsk', 'bypass')).toBe('manual')
    expect(resolveAgentPermissionMode('acp', 'claude', 'plan', 'bypass')).toBe('plan')
    expect(resolveAgentPermissionMode('acp', 'codex', 'agent-full-access', 'accept-edits')).toBe('bypass')
    // Not postures: pi's thinking levels, or an Object prototype key.
    expect(resolveAgentPermissionMode('acp', 'pi', 'high', 'bypass')).toBeUndefined()
    expect(resolveAgentPermissionMode('acp', 'claude', 'constructor', 'bypass')).toBeUndefined()
  })

  it("reads claude's own mode names, with `manual` arriving as `default`", () => {
    expect(resolveAgentPermissionMode('tui', 'claude', 'bypassPermissions', 'plan')).toBe('bypass')
    expect(resolveAgentPermissionMode('tui', 'claude', 'acceptEdits', 'plan')).toBe('accept-edits')
    expect(resolveAgentPermissionMode('tui', 'claude', 'default', 'plan')).toBe('manual')
    expect(resolveAgentPermissionMode('tui', 'claude', 'dontAsk', 'plan')).toBe('manual')
    expect(resolveAgentPermissionMode('tui', 'claude', 'constructor', 'plan')).toBeUndefined()
  })

  // An opencode posture is the agent plus the process's rules. plan and
  // manual share rules and differ only by agent.
  it('reads an opencode agent against the rules the workspace runs under', () => {
    expect(resolveAgentPermissionMode('tui', 'opencode', 'build', 'plan')).toBe('manual')
    expect(resolveAgentPermissionMode('tui', 'opencode', 'plan', 'manual')).toBe('plan')
    expect(resolveAgentPermissionMode('tui', 'opencode', 'build', 'accept-edits')).toBe('accept-edits')
    // Neither plan with looser rules nor a project's own agent is a posture.
    expect(resolveAgentPermissionMode('tui', 'opencode', 'plan', 'bypass')).toBeUndefined()
    expect(resolveAgentPermissionMode('tui', 'opencode', 'reviewer', 'manual')).toBeUndefined()
  })

  it('reads nothing from a tool that reports no mode on its pane', () => {
    expect(resolveAgentPermissionMode('tui', 'codex', 'bypassPermissions', 'plan')).toBeUndefined()
    expect(resolveAgentPermissionMode('tui', 'pi', 'plan', 'bypass')).toBeUndefined()
  })
})
