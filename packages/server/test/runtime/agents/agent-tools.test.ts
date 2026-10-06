import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  agentStatusFormat,
  agentWindowName,
  agentWindowTool,
  classifyAgentObservation,
  getAgentSessionFirstMessage,
  resolveAgentPermissionMode,
} from '#runtime/agents/agent-tools'
import type { SandboxFile } from '#runtime/agents/sandbox-fs'
import type { WorkspaceDriver } from '#drivers/contract'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type { AgentTool } from '@yaac/shared/types'

describe('agentStatusFormat', () => {
  it('subscribes title tools to the pane title, classified server-side', () => {
    expect(agentStatusFormat('claude')).toBe('#{pane_title}')
    expect(agentStatusFormat('codex')).toBe('#{pane_title}')
  })

  // tmux evaluates these itself, so they are pinned exactly: small mistakes
  // still parse but mean something else.
  // test-playwright-scripts/verify-tmux-status-format.js checks the markers
  // against a live tmux. opencode's progress strip needs 4+ cells so short
  // runs in transcript text do not match.
  it('resolves opencode and pi tmux-side by a case-insensitive content search', () => {
    expect(agentStatusFormat('opencode')).toBe(
      '#{?#{||:#{C/ri:esc\\s+(again\\s+to\\s+)?interrupt},#{C/ri:[■⬝][■⬝][■⬝][■⬝]}},running,waiting}',
    )
    expect(agentStatusFormat('pi')).toBe(
      '#{?#{||:#{C/ri:esc\\s+(to\\s+)?(interrupt|cancel|stop)},'
        + '#{C/ri:\\b(thinking|working|generating|streaming|running)\\b}},running,waiting}',
    )
  })
})

/**
 * Titles observed from live tools. claude and codex show a Braille spinner
 * (claude also the circle phases ◐◑, from 2.1.228) at the first character
 * while a turn runs. Every state waiting on the user, including a permission
 * dialog or codex's blinking "Action Required", has none. Until the tool
 * sets a title, `#{pane_title}` is the hostname.
 */
describe('classifyAgentObservation', () => {
  const HOSTNAME = 'yaac-yaac-ee9cb586-74d3-4a1f-9d1f-482839b26d70-5tfxq'
  const cases = {
    claude: {
      // The whole Braille block and all four circle phases, with or without
      // display-message's trailing newline.
      running: ['⠐ Create marker', '⠋ Fix the bug', '⠀ edge', '⣿ edge', '◐ Review PR', '◑ Review PR',
        '◒ edge', '◓ edge', '⠹ Summarize\n', '◐ Summarize\n'],
      // Neighbouring geometric glyphs claude uses elsewhere, and a spinner
      // anywhere but the first character.
      waiting: ['✳ Create marker', '✳ Claude Code', HOSTNAME, '', '● Ran a command', '○ Pending',
        '◆ Marker', '◔ Past the phases', '✳ Fix ⠋ rendering', '✳ Fix ◐ rendering', ' ⠋ lead', ' ◐ lead'],
    },
    codex: {
      running: ['⠴ workdir', '⠋ yaac', '⠀ edge', '⣿ edge', '⠹ workdir\n'],
      waiting: ['workdir', '[ ! ] Action Required workdir', '[ . ] Action Required workdir', HOSTNAME, '',
        'fix ⠋ rendering', ' ⠋ lead'],
    },
    // Verdicts already resolved tmux-side.
    opencode: { running: ['running'], waiting: ['waiting'] },
    pi: { running: [' running '], waiting: ['waiting'] },
  } as const

  it.each(Object.entries(cases))('classifies %s observations', (tool, { running, waiting }) => {
    for (const t of running) expect(classifyAgentObservation(tool as AgentTool, t), t).toBe('running')
    for (const t of waiting) expect(classifyAgentObservation(tool as AgentTool, t), t).toBe('waiting')
  })
})

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

describe('agentWindowTool', () => {
  it('reads back every name agentWindowName can produce', () => {
    for (const tool of ['claude', 'codex', 'opencode', 'pi'] as const) {
      for (const i of [0, 1, 9]) {
        expect(agentWindowTool(agentWindowName(tool, i))).toBe(tool)
      }
    }
  })

  it("matches any tool, not just the workspace's own", () => {
    // Otherwise a restart would forget a codex conversation in a claude
    // workspace.
    expect(agentWindowTool('codex-2')).toBe('codex')
  })

  it('excludes init-command windows and scratch shells', () => {
    expect(agentWindowTool('shell')).toBeUndefined()
    expect(agentWindowTool('dev')).toBeUndefined()
    expect(agentWindowTool('claude-ish')).toBeUndefined()
    expect(agentWindowTool('myclaude')).toBeUndefined()
    expect(agentWindowTool('claude-')).toBeUndefined()
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
    // As codex 0.159.3 writes it.
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
  })

  it('scans a line that never ends in time linear in its length', async () => {
    const file = await transcript(['x'.repeat(16 * 1024 * 1024), user('after')])
    const started = Date.now()
    expect(await getAgentSessionFirstMessage('claude', file)).toBe('after')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  // opencode has no host transcript: its title is probed in the running
  // workspace, by session id since `session.list` returns only the 50 most
  // recently updated.
  it('asks a live opencode workspace for the named session’s title only', async () => {
    const exec = vi.fn<WorkspaceDriver['exec']>((_job, cmd) => {
      const id = /sessionID=(\S+)$/.exec(cmd)?.[1]
      if (id === 'ses_titled') return Promise.resolve({ stdout: JSON.stringify({ data: { id, title: 'OLIVE' } }) + '\n', stderr: '' })
      // No `title` key until opencode has titled the session.
      if (id === 'ses_untitled') return Promise.resolve({ stdout: JSON.stringify({ data: { id } }), stderr: '' })
      return Promise.reject(new Error('HTTP 404 Not Found'))
    })
    installFakeWorkspaceDriver({ exec })
    const first = (id: string | undefined, job: string | undefined = 'container') =>
      getAgentSessionFirstMessage('opencode', { projectId: 'demo', dir, rel: 'ignored.jsonl' }, job, id)

    expect(await first('ses_titled')).toBe('OLIVE')
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(['container', 'opencode api --standalone session.get --param sessionID=ses_titled'])
    for (const id of ['ses_untitled', 'ses_gone']) expect(await first(id)).toBeUndefined()
    // No live workspace, a workspace id, no id, or a malformed id never
    // reaches the command line.
    exec.mockClear()
    for (const id of ['wt-1', undefined, 'ses_foo-bar']) expect(await first(id)).toBeUndefined()
    expect(await getAgentSessionFirstMessage('opencode', undefined, undefined, 'ses_titled')).toBeUndefined()
    expect(exec).not.toHaveBeenCalled()
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
