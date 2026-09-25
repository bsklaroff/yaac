import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  agentStatusFormat,
  agentWindowName,
  agentWindowTool,
  classifyAgentObservation,
  getAgentSessionFirstMessage,
  getAgentSessionPermissionMode,
  resolveAgentPermissionMode,
} from '#runtime/agents/agent-tools'
import { _resetCodexPosturesForTests } from '#runtime/agents/codex'
// The marker lists are the tool modules' business — imported here as setup
// values so the format assertions survive a wording change to either.
import { OPENCODE_BUSY_MARKERS } from '#runtime/agents/opencode'
import { PI_BUSY_MARKERS } from '#runtime/agents/pi'

describe('agentStatusFormat', () => {
  it('subscribes title tools to the pane title, classified server-side', () => {
    expect(agentStatusFormat('claude')).toBe('#{pane_title}')
    expect(agentStatusFormat('codex')).toBe('#{pane_title}')
  })

  // Pane tools resolve the verdict inside tmux, so the format string IS the
  // contract with tmux — assert it exactly. The OR nesting, the comma that
  // separates `#{||:}` arguments, the marker order, and the trailing
  // `,running,waiting` are each a way for this to keep parsing but stop
  // meaning what it says. The markers themselves come from the tool modules
  // (setup values, not the thing under test), so rewording one doesn't drag
  // this test along.
  it.each(['opencode', 'pi'] as const)('resolves %s tmux-side by content search', (tool) => {
    const [first, second] = tool === 'opencode' ? OPENCODE_BUSY_MARKERS : PI_BUSY_MARKERS
    expect(agentStatusFormat(tool)).toBe(
      `#{?#{||:#{C/ri:${first}},#{C/ri:${second}}},running,waiting}`,
    )
  })

  // The nesting above is only exercised for two markers because that is what
  // both tools ship. Spelled out for opencode's real list so a reader can see
  // the shape tmux actually receives.
  it("nests opencode's markers into one case-insensitive content search", () => {
    expect(agentStatusFormat('opencode')).toBe(
      '#{?#{||:#{C/ri:esc\\s+(again\\s+to\\s+)?interrupt},#{C/ri:[■⬝][■⬝][■⬝][■⬝]}},running,waiting}',
    )
  })

})

describe('classifyAgentObservation', () => {
  it('classifies claude/codex titles by their spinner prefix', () => {
    // claude's spinner glyphs are release-dependent (Braille through
    // 2.1.226, the circle phases from 2.1.228) — both route to running.
    expect(classifyAgentObservation('claude', '⠋ Fixing the bug')).toBe('running')
    expect(classifyAgentObservation('claude', '◐ Fixing the bug')).toBe('running')
    expect(classifyAgentObservation('claude', '✳ idle prompt')).toBe('waiting')
    expect(classifyAgentObservation('codex', '⠙ project')).toBe('running')
    expect(classifyAgentObservation('codex', '[ ! ] Action Required project')).toBe('waiting')
  })

  it('passes through opencode/pi verdicts already resolved tmux-side', () => {
    // The subscription format yields the word directly; the watcher only
    // trims and maps it (never re-classifies pane content).
    expect(classifyAgentObservation('opencode', 'running')).toBe('running')
    expect(classifyAgentObservation('opencode', 'waiting')).toBe('waiting')
    expect(classifyAgentObservation('pi', ' running ')).toBe('running')
    expect(classifyAgentObservation('pi', 'waiting')).toBe('waiting')
  })
})

describe('agentWindowName', () => {
  it("gives the worktree's first agent the bare tool name", () => {
    // Every existing `yaac:<tool>` target — prompt paste, `attach --agent`,
    // the terminals listing — depends on this staying unsuffixed.
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

  it("matches any tool, not just the worktree's own", () => {
    // A codex conversation opened inside a claude worktree must still be
    // classified; missing it leaves the pane out of the live set, and the
    // next restart silently forgets the conversation.
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
  it('reads a claude transcript from the recorded path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-first-msg-'))
    const jsonl = path.join(dir, 't.jsonl')
    await fs.writeFile(jsonl, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'ship the refactor' },
    }) + '\n')
    await expect(getAgentSessionFirstMessage('claude', jsonl)).resolves.toBe('ship the refactor')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns undefined without a recorded path', async () => {
    // There is deliberately no by-id fallback: a `/clear` conversation has an
    // id yaac never chose, and codex's rollout filename is derivable from no
    // id at all — the recorded path is the only handle.
    await expect(getAgentSessionFirstMessage('claude', undefined)).resolves.toBeUndefined()
    await expect(getAgentSessionFirstMessage('codex', undefined)).resolves.toBeUndefined()
    await expect(getAgentSessionFirstMessage('pi', undefined)).resolves.toBeUndefined()
  })

  it('returns undefined for opencode with no live pod to probe', async () => {
    // opencode keeps its history in a container-local sqlite DB, so its first
    // message is an HTTP probe into the running pod and is gone with it.
    await expect(getAgentSessionFirstMessage('opencode', '/tmp/ignored.jsonl')).resolves.toBeUndefined()
  })
})

describe('resolveAgentPermissionMode', () => {
  // An adapter's session mode ids, read back through its profile — including
  // claude's one id that does not read across (`default` is `manual`).
  it('reads an acp mode id back through the adapter it came from', () => {
    expect(resolveAgentPermissionMode('acp', 'claude', 'default', 'bypass')).toBe('manual')
    expect(resolveAgentPermissionMode('acp', 'claude', 'plan', 'bypass')).toBe('plan')
    expect(resolveAgentPermissionMode('acp', 'codex', 'agent-full-access', 'accept-edits')).toBe('bypass')
    // No posture stands for these, so none is recorded: claude's `dontAsk`,
    // pi's thinking levels.
    expect(resolveAgentPermissionMode('acp', 'claude', 'dontAsk', 'bypass')).toBeUndefined()
    expect(resolveAgentPermissionMode('acp', 'pi', 'high', 'bypass')).toBeUndefined()
  })

  it("reads claude's own mode names, with `manual` arriving as `default`", () => {
    expect(resolveAgentPermissionMode('tui', 'claude', 'bypassPermissions', 'plan')).toBe('bypass')
    expect(resolveAgentPermissionMode('tui', 'claude', 'acceptEdits', 'plan')).toBe('accept-edits')
    expect(resolveAgentPermissionMode('tui', 'claude', 'default', 'plan')).toBe('manual')
    expect(resolveAgentPermissionMode('tui', 'claude', 'dontAsk', 'plan')).toBeUndefined()
  })

  // An opencode agent is half a posture; the rules the running process has
  // are the other half. plan and manual share theirs, so the agent alone
  // moves between them — and nowhere else.
  it('reads an opencode agent against the rules the worktree runs under', () => {
    expect(resolveAgentPermissionMode('tui', 'opencode', 'build', 'plan')).toBe('manual')
    expect(resolveAgentPermissionMode('tui', 'opencode', 'plan', 'manual')).toBe('plan')
    expect(resolveAgentPermissionMode('tui', 'opencode', 'build', 'accept-edits')).toBe('accept-edits')
    // The plan agent over looser rules is no posture yaac has; nor is an agent
    // of a project's own.
    expect(resolveAgentPermissionMode('tui', 'opencode', 'plan', 'bypass')).toBeUndefined()
    expect(resolveAgentPermissionMode('tui', 'opencode', 'reviewer', 'manual')).toBeUndefined()
  })

  it('reads nothing from a tool that reports no mode on its pane', () => {
    expect(resolveAgentPermissionMode('tui', 'codex', 'bypassPermissions', 'plan')).toBeUndefined()
    expect(resolveAgentPermissionMode('tui', 'pi', 'plan', 'bypass')).toBeUndefined()
  })
})

describe('getAgentSessionPermissionMode', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-posture-'))
    _resetCodexPosturesForTests()
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  let n = 0
  const rollout = async (entries: unknown[]): Promise<string> => {
    const jsonl = path.join(dir, `rollout-${String(n++)}.jsonl`)
    await fs.writeFile(jsonl, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    return jsonl
  }

  // The permission profiles codex 0.156.1 writes: full access is `disabled`,
  // and a managed profile is workspace-write when it grants a write, read-only
  // when it grants none.
  const FULL = { type: 'disabled' }
  const WORKSPACE = {
    type: 'managed',
    file_system: {
      type: 'restricted',
      entries: [
        { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
        { path: { type: 'path', path: '/workspace' }, access: 'write' },
      ],
    },
  }
  const READ_ONLY = {
    type: 'managed',
    file_system: { type: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }] },
  }
  const settings = (s: Record<string, unknown>): Record<string, unknown> => ({
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    permission_profile: WORKSPACE,
    collaboration_mode: { mode: 'default' },
    ...s,
  })
  const turnContext = (s: Record<string, unknown> = {}): unknown =>
    ({ type: 'turn_context', payload: { model: 'gpt-6-astra', ...settings(s) } })
  const applied = (s: Record<string, unknown> = {}): unknown => ({
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_id: 't', thread_settings: settings(s) },
  })

  // Each of yaac's codex launches, read back out of the settings it produced.
  it('inverts every codex launch the posture table makes', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ approval_policy: 'never', permission_profile: FULL }, 'bypass'],
      [{ approvals_reviewer: 'auto_review' }, 'auto'],
      [{}, 'accept-edits'],
      [{ permission_profile: READ_ONLY }, 'read-only'],
    ]
    for (const [s, mode] of cases) {
      expect((await getAgentSessionPermissionMode('codex', await rollout([turnContext(s)])))?.permissionMode).toBe(mode)
    }
  })

  // A `/permissions` pick or a Shift+Tab lands in the rollout as a settings
  // event straight away — the newest entry wins, whichever kind it is.
  it('follows a mid-session change without waiting for the next turn', async () => {
    const jsonl = await rollout([
      turnContext(),
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      { ...applied({ approval_policy: 'never', permission_profile: FULL }) as object, timestamp: '2026-09-24T20:21:41.151Z' },
    ])
    // With when it was written — which is what tells this process's settings
    // from the ones a restart resumed.
    await expect(getAgentSessionPermissionMode('codex', jsonl))
      .resolves.toEqual({ permissionMode: 'bypass', atMs: Date.parse('2026-09-24T20:21:41.151Z') })

    // Codex's own plan mode is only instructions to the model, over whatever
    // sandbox is in force, so it says nothing about the posture.
    await fs.appendFile(jsonl, JSON.stringify(applied({
      approval_policy: 'never', permission_profile: FULL, collaboration_mode: { mode: 'plan' },
    })) + '\n')
    expect((await getAgentSessionPermissionMode('codex', jsonl))?.permissionMode).toBe('bypass')
  })

  // Settings the launch table never makes read as the most permissive posture
  // that lets the agent do no more unasked than they do.
  it('reads settings past the launch table as the nearest posture no looser', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ permission_profile: FULL }, 'bypass'],
      [{ approval_policy: 'never' }, 'accept-edits'],
      [{ approval_policy: 'never', permission_profile: READ_ONLY }, 'read-only'],
      [{ approvals_reviewer: 'auto_review', permission_profile: READ_ONLY }, 'auto'],
    ]
    for (const [s, mode] of cases) {
      expect((await getAgentSessionPermissionMode('codex', await rollout([turnContext(s)])))?.permissionMode).toBe(mode)
    }
  })

  // Settings nothing can be said about are the answer — not an older entry
  // that named one, which would claim a posture codex has since left.
  it('answers nothing for settings no posture stands for', async () => {
    const jsonl = await rollout([turnContext(), applied({ approval_policy: { granular: {} } })])
    await expect(getAgentSessionPermissionMode('codex', jsonl)).resolves.toBeUndefined()
  })

  it('reads nothing, and touches nothing, for a tool that records no posture there', async () => {
    const jsonl = await rollout([turnContext()])
    await expect(getAgentSessionPermissionMode('claude', jsonl)).resolves.toBeUndefined()
    await expect(getAgentSessionPermissionMode('codex', undefined)).resolves.toBeUndefined()
    await expect(getAgentSessionPermissionMode('codex', path.join(dir, 'missing.jsonl'))).resolves.toBeUndefined()
  })
})
