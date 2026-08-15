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
  getAgentSessionModel,
} from '#runtime/agents/agent-tools'
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

describe('getAgentSessionModel', () => {
  /** A transcript written as the tool writes it, one entry per line. */
  const transcript = async (dir: string, entries: unknown[]): Promise<string> => {
    const jsonl = path.join(dir, 't.jsonl')
    await fs.writeFile(jsonl, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    return jsonl
  }

  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-model-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  // The whole point of reading the transcript rather than the launch: each
  // tool records the model per turn, so a `/model` mid-conversation is
  // visible, and the LAST one is what the worktree is answering as now.
  it('takes the latest model a claude transcript answered as', async () => {
    const jsonl = await transcript(dir, [
      { type: 'user', message: { role: 'user', content: 'start' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } },
      { type: 'user', message: { role: 'user', content: 'switch' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5' } },
    ])
    await expect(getAgentSessionModel('claude', jsonl)).resolves.toBe('claude-fable-5')
  })

  // `<synthetic>` is claude's placeholder on entries no model produced (an
  // interrupt notice, an API-error stand-in). Naming it would show the
  // worktree answering as a model that does not exist, so the read falls
  // through to the last real answer — which is still what the next turn uses.
  it("skips claude's synthetic entries", async () => {
    const jsonl = await transcript(dir, [
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } },
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>' } },
    ])
    await expect(getAgentSessionModel('claude', jsonl)).resolves.toBe('claude-opus-5')
  })

  // codex names no model on the messages themselves — it writes a
  // `turn_context` at each turn boundary carrying that turn's settings, so
  // that is what the reader follows.
  it("takes the latest model from codex's turn boundaries", async () => {
    const jsonl = await transcript(dir, [
      { type: 'session_meta', payload: { id: 'abc' } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'medium' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol-mini', effort: 'high' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    ])
    await expect(getAgentSessionModel('codex', jsonl)).resolves.toBe('gpt-5.6-sol-mini')
  })

  // pi qualifies its model with the provider, which is the spelling its own
  // `--model` flag takes — so that is the spelling stored.
  it('qualifies a pi model with its provider', async () => {
    const jsonl = await transcript(dir, [
      { type: 'message', message: { role: 'user', content: 'start' } },
      {
        type: 'message',
        message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-4-8' },
      },
    ])
    await expect(getAgentSessionModel('pi', jsonl)).resolves.toBe('anthropic/claude-opus-4-8')
  })

  // pi appends a `model_change` when the model is switched BEFORE anything
  // has answered as it, so a session that has only just been switched still
  // reports the model its next turn will use. Reading both kinds — latest
  // wins — is what pi itself does to resolve a session's current model.
  it('prefers a later pi model_change over the last answer', async () => {
    const jsonl = await transcript(dir, [
      {
        type: 'message',
        message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-4-8' },
      },
      { type: 'model_change', provider: 'openai', modelId: 'gpt-5.6' },
    ])
    await expect(getAgentSessionModel('pi', jsonl)).resolves.toBe('openai/gpt-5.6')
  })

  it('reports no model before the agent has answered', async () => {
    // A worktree whose agent has been asked something but has not replied.
    // Absent is the honest answer, and it self-heals on the first reply.
    const jsonl = await transcript(dir, [
      { type: 'user', message: { role: 'user', content: 'ship the refactor' } },
    ])
    await expect(getAgentSessionModel('claude', jsonl)).resolves.toBeUndefined()
  })

  // The scan reads backwards in chunks, so a transcript longer than one chunk
  // is the case that proves the carryover reassembles lines across a boundary
  // rather than dropping or splitting the one that straddles it. The model
  // sits at the very FRONT, so finding it means the walk reached the far end.
  it('finds a model past many chunks of tool output', async () => {
    const filler = { type: 'user', message: { role: 'user', content: 'x'.repeat(500) } }
    const jsonl = await transcript(dir, [
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } },
      ...Array.from({ length: 200 }, () => filler),
    ])
    await expect(getAgentSessionModel('claude', jsonl)).resolves.toBe('claude-opus-5')
  })

  // Multi-byte text spanning a chunk boundary must not corrupt the entry that
  // carries the model: the scan splits on newline bytes and decodes each line
  // from its own complete byte range, so no glyph is ever cut in half.
  it('survives multi-byte content across chunk boundaries', async () => {
    const filler = { type: 'user', message: { role: 'user', content: '日本語テキスト'.repeat(80) } }
    const jsonl = await transcript(dir, [
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } },
      ...Array.from({ length: 40 }, () => filler),
    ])
    await expect(getAgentSessionModel('claude', jsonl)).resolves.toBe('claude-opus-5')
  })

  // The sweep runs on a tick, not on a lock, so it routinely reads a
  // transcript the tool is in the middle of appending to — a half-written
  // last line is the ordinary case, not a corrupt file. It must be skipped
  // rather than allowed to end the scan, or a busy conversation would report
  // no model exactly while it was working.
  it('skips a half-written trailing line and answers from the one before', async () => {
    const jsonl = path.join(dir, 't.jsonl')
    await fs.writeFile(jsonl, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } }),
      '{"type":"assistant","message":{"role":"assistant","model":"claude-fab',
    ].join('\n'))
    await expect(getAgentSessionModel('claude', jsonl)).resolves.toBe('claude-opus-5')
  })

  it('reports no model for an empty transcript', async () => {
    // The file a tool creates before it writes anything into it.
    const jsonl = path.join(dir, 't.jsonl')
    await fs.writeFile(jsonl, '')
    await expect(getAgentSessionModel('claude', jsonl)).resolves.toBeUndefined()
  })

  it('reads a transcript whose last line has no trailing newline', async () => {
    // Whether the newest entry ends in a newline is up to whoever wrote it,
    // and the answer must not depend on that.
    const jsonl = path.join(dir, 't.jsonl')
    await fs.writeFile(jsonl, JSON.stringify({
      type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' },
    }))
    await expect(getAgentSessionModel('claude', jsonl)).resolves.toBe('claude-opus-5')
  })

  it('reports no model for a missing transcript or an unrecorded path', async () => {
    await expect(getAgentSessionModel('claude', path.join(dir, 'gone.jsonl'))).resolves.toBeUndefined()
    await expect(getAgentSessionModel('claude', undefined)).resolves.toBeUndefined()
    await expect(getAgentSessionModel('codex', undefined)).resolves.toBeUndefined()
  })

  it('reports no model for opencode, which leaves no transcript to read', async () => {
    // Unlike a first message there is no HTTP probe for this — an opencode
    // conversation simply has no model to show, running or not.
    const jsonl = await transcript(dir, [
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } },
    ])
    await expect(getAgentSessionModel('opencode', jsonl)).resolves.toBeUndefined()
  })
})
