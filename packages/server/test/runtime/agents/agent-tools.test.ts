import { describe, it, expect } from 'vitest'
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
// Setup values, so a wording change to a marker does not break these tests.
import { OPENCODE_BUSY_MARKERS } from '#runtime/agents/opencode'
import { PI_BUSY_MARKERS } from '#runtime/agents/pi'

describe('agentStatusFormat', () => {
  it('subscribes title tools to the pane title, classified server-side', () => {
    expect(agentStatusFormat('claude')).toBe('#{pane_title}')
    expect(agentStatusFormat('codex')).toBe('#{pane_title}')
  })

  // tmux evaluates this format itself, so assert it exactly: small mistakes
  // still parse but mean something else.
  it.each(['opencode', 'pi'] as const)('resolves %s tmux-side by content search', (tool) => {
    const [first, second] = tool === 'opencode' ? OPENCODE_BUSY_MARKERS : PI_BUSY_MARKERS
    expect(agentStatusFormat(tool)).toBe(
      `#{?#{||:#{C/ri:${first}},#{C/ri:${second}}},running,waiting}`,
    )
  })

  // Spelled out for opencode's real markers, to show what tmux receives.
  it("nests opencode's markers into one case-insensitive content search", () => {
    expect(agentStatusFormat('opencode')).toBe(
      '#{?#{||:#{C/ri:esc\\s+(again\\s+to\\s+)?interrupt},#{C/ri:[■⬝][■⬝][■⬝][■⬝]}},running,waiting}',
    )
  })

})

describe('classifyAgentObservation', () => {
  it('classifies claude/codex titles by their spinner prefix', () => {
    // claude's spinner glyphs vary by release; both sets mean running.
    expect(classifyAgentObservation('claude', '⠋ Fixing the bug')).toBe('running')
    expect(classifyAgentObservation('claude', '◐ Fixing the bug')).toBe('running')
    expect(classifyAgentObservation('claude', '✳ idle prompt')).toBe('waiting')
    expect(classifyAgentObservation('codex', '⠙ project')).toBe('running')
    expect(classifyAgentObservation('codex', '[ ! ] Action Required project')).toBe('waiting')
  })

  it('passes through opencode/pi verdicts already resolved tmux-side', () => {
    expect(classifyAgentObservation('opencode', 'running')).toBe('running')
    expect(classifyAgentObservation('opencode', 'waiting')).toBe('waiting')
    expect(classifyAgentObservation('pi', ' running ')).toBe('running')
    expect(classifyAgentObservation('pi', 'waiting')).toBe('waiting')
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
  it('reads a claude transcript from the recorded path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-first-msg-'))
    const jsonl = path.join(dir, 't.jsonl')
    await fs.writeFile(jsonl, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'ship the refactor' },
    }) + '\n')
    await expect(getAgentSessionFirstMessage('claude', { slug: 'demo', dir, rel: 't.jsonl' })).resolves.toBe('ship the refactor')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns undefined without a recorded path', async () => {
    // No lookup by id: a `/clear` conversation's id is not yaac's, and a
    // codex rollout's filename cannot be derived from one.
    await expect(getAgentSessionFirstMessage('claude', undefined)).resolves.toBeUndefined()
    await expect(getAgentSessionFirstMessage('codex', undefined)).resolves.toBeUndefined()
    await expect(getAgentSessionFirstMessage('pi', undefined)).resolves.toBeUndefined()
  })

  it('returns undefined for opencode with no live pod to probe', async () => {
    // opencode's history is only reachable through the running pod.
    await expect(getAgentSessionFirstMessage('opencode', { slug: 'demo', dir: '/tmp', rel: 'ignored.jsonl' })).resolves.toBeUndefined()
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
