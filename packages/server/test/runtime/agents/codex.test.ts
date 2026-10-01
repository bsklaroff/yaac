import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  _resetCodexPosturesForTests,
  classifyCodexTitle,
  codexRolloutParent,
  codexRolloutThreadId,
  getCodexFirstUserMessage,
  getCodexPermissionMode,
} from '#runtime/agents/codex'
import type { SandboxFile } from '#runtime/agents/sandbox-fs'

/** A file as the readers take it: its dir plus its name. */
const at = (file: string): SandboxFile => ({ slug: 'demo', dir: path.dirname(file), rel: path.basename(file) })

// Titles observed from codex-cli 0.142.4: a running turn shows a Braille
// spinner before the project name, idle shows just the name, and an
// approval prompt shows a blinking "[ ! ] Action Required" prefix.
describe('classifyCodexTitle', () => {
  it('returns running for a Braille-spinner title (turn in flight)', () => {
    expect(classifyCodexTitle('⠴ workdir')).toBe('running')
    expect(classifyCodexTitle('⠋ yaac')).toBe('running')
  })

  it('returns running across the whole Braille block', () => {
    // Accept the whole U+2800–U+28FF range.
    expect(classifyCodexTitle('⠀ edge of block')).toBe('running')
    expect(classifyCodexTitle('⣿ edge of block')).toBe('running')
  })

  it('returns running for a bare spinner with trailing newline (display-message output)', () => {
    expect(classifyCodexTitle('⠹ workdir\n')).toBe('running')
  })

  it('returns waiting for the idle bare-project-name title', () => {
    expect(classifyCodexTitle('workdir')).toBe('waiting')
  })

  it('returns waiting while an approval prompt is up', () => {
    // Both blink phases read as waiting.
    expect(classifyCodexTitle('[ ! ] Action Required workdir')).toBe('waiting')
    expect(classifyCodexTitle('[ . ] Action Required workdir')).toBe('waiting')
  })

  it('returns waiting for the tmux default title (codex has not set one)', () => {
    // Until codex sets a title, #{pane_title} is the hostname.
    expect(classifyCodexTitle('yaac-yaac-ee9cb586-74d3-4a1f-9d1f-482839b26d70-5tfxq')).toBe('waiting')
  })

  it('returns waiting for an empty title', () => {
    expect(classifyCodexTitle('')).toBe('waiting')
  })

  it('only matches the spinner at the first character', () => {
    expect(classifyCodexTitle('fix ⠋ spinner rendering')).toBe('waiting')
    expect(classifyCodexTitle(' ⠋ leading space')).toBe('waiting')
  })
})

describe('getCodexFirstUserMessage', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-first-msg-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeEntry(entry: Record<string, unknown>): Promise<void> {
    return fs.appendFile(jsonlPath, JSON.stringify(entry) + '\n')
  }

  it('returns message from event_msg entry', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc', model: 'gpt-4' })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'fix the login bug' } })
    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBe('fix the login bug')
  })

  it('returns the message of a completed UserMessage item, as codex 0.159.3 writes it', async () => {
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } })
    await writeEntry({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'hi' }] } } })
    await writeEntry({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'hello' }] } },
    })
    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBe('hello')
  })

  it('returns undefined when no event_msg exists', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc' })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBeUndefined()
  })

  it('returns undefined when file does not exist', async () => {
    expect(await getCodexFirstUserMessage(at(path.join(tmpDir, 'nonexistent.jsonl')))).toBeUndefined()
  })

  it('returns undefined for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBeUndefined()
  })

  it('skips non-event_msg entries', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc' })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'second prompt' } })
    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBe('second prompt')
  })

  it('ignores bootstrap response_item user messages and reads the user_message event', async () => {
    await writeEntry({ type: 'session_meta', payload: { id: 'abc' } })
    await writeEntry({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace' }],
      },
    })
    await writeEntry({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'fix the login bug' }],
      },
    })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'fix the login bug' } })
    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBe('fix the login bug')
  })

  it('finds the first user_message beyond the first 8KB of the file', async () => {
    await writeEntry({
      type: 'session_meta',
      payload: {
        id: 'abc',
        base_instructions: { text: 'x'.repeat(12000) },
      },
    })
    await writeEntry({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace' }],
      },
    })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'fix the login bug' } })

    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBe('fix the login bug')
  })

  it('ignores the legacy top-level event_msg message shape', async () => {
    await writeEntry({ type: 'event_msg', message: 'legacy prompt', images: [] })
    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBeUndefined()
  })

  it('ignores non-user event_msg payloads', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'internal note' } })
    expect(await getCodexFirstUserMessage(at(jsonlPath))).toBeUndefined()
  })
})

describe('getCodexPermissionMode', () => {
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

  // Profiles codex 0.159.3 writes: full access is `disabled`; a managed
  // profile is workspace-write if it grants a write, else read-only.
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

  it('inverts every codex launch the posture table makes', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ approval_policy: 'never', permission_profile: FULL }, 'bypass'],
      [{ approvals_reviewer: 'auto_review' }, 'auto'],
      [{}, 'accept-edits'],
      [{ permission_profile: READ_ONLY }, 'read-only'],
    ]
    for (const [s, mode] of cases) {
      expect((await getCodexPermissionMode(at(await rollout([turnContext(s)]))))?.permissionMode).toBe(mode)
    }
  })

  // `/permissions` or Shift+Tab writes a settings event at once; the newest
  // entry wins.
  it('follows a mid-session change without waiting for the next turn', async () => {
    const jsonl = await rollout([
      turnContext(),
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      { ...applied({ approval_policy: 'never', permission_profile: FULL }) as object, timestamp: '2026-09-24T20:21:41.151Z' },
    ])
    // The timestamp tells this run's settings from ones a restart resumed.
    await expect(getCodexPermissionMode(at(jsonl)))
      .resolves.toEqual({ permissionMode: 'bypass', atMs: Date.parse('2026-09-24T20:21:41.151Z') })

    // Plan mode only instructs the model; it does not change the sandbox.
    await fs.appendFile(jsonl, JSON.stringify(applied({
      approval_policy: 'never', permission_profile: FULL, collaboration_mode: { mode: 'plan' },
    })) + '\n')
    expect((await getCodexPermissionMode(at(jsonl)))?.permissionMode).toBe('bypass')
  })

  // Unknown settings map to the loosest posture that is no looser than them.
  it('reads settings past the launch table as the nearest posture no looser', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ permission_profile: FULL }, 'bypass'],
      [{ approval_policy: 'never' }, 'accept-edits'],
      [{ approval_policy: 'never', permission_profile: READ_ONLY }, 'read-only'],
      [{ approvals_reviewer: 'auto_review', permission_profile: READ_ONLY }, 'auto'],
    ]
    for (const [s, mode] of cases) {
      expect((await getCodexPermissionMode(at(await rollout([turnContext(s)]))))?.permissionMode).toBe(mode)
    }
  })

  // Unrecognized settings yield nothing, not an older entry's posture.
  it('answers nothing for settings no posture stands for', async () => {
    const jsonl = await rollout([turnContext(), applied({ approval_policy: { granular: {} } })])
    await expect(getCodexPermissionMode(at(jsonl))).resolves.toBeUndefined()
  })

  it('reads nothing from a rollout that is not there', async () => {
    await expect(getCodexPermissionMode(at(path.join(dir, 'missing.jsonl')))).resolves.toBeUndefined()
  })
})

describe('codexRolloutThreadId', () => {
  it('reads the thread id out of codex\'s rollout name, plain or compressed', () => {
    const id = '01a0ec4b-6990-7182-92ca-65550d232d3c'
    expect(codexRolloutThreadId(`rollout-2026-09-29T08-32-40-${id}.jsonl`)).toBe(id)
    expect(codexRolloutThreadId(`rollout-2026-09-29T08-32-40-${id}.jsonl.zst`)).toBe(id)
    expect(codexRolloutThreadId(`${id}.jsonl`)).toBeUndefined()
    expect(codexRolloutThreadId('rollout-thread-42.jsonl')).toBeUndefined()
  })
})

describe('codexRolloutParent', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-lineage-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  async function rollout(meta: Record<string, unknown>, type = 'session_meta'): Promise<SandboxFile> {
    const file = path.join(dir, `r-${String(Math.random()).slice(2)}.jsonl`)
    // Real first lines are around 20 KB because of the base instructions.
    const payload = { id: 'child', base_instructions: 'x'.repeat(30_000), ...meta }
    await fs.writeFile(file, `${JSON.stringify({ type, payload })}\n{"type":"event_msg"}\n`)
    return at(file)
  }

  it('names a spawned child\'s parent, and a fork\'s origin', async () => {
    expect(await codexRolloutParent(await rollout({
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
    }))).toBe('parent')
    expect(await codexRolloutParent(await rollout({ source: 'cli', forked_from_id: 'origin' }))).toBe('origin')
  })

  it('has none for a root thread, another first line, or no file', async () => {
    expect(await codexRolloutParent(await rollout({ source: 'cli' }))).toBeUndefined()
    expect(await codexRolloutParent(await rollout({ forked_from_id: 'x' }, 'turn_context'))).toBeUndefined()
    expect(await codexRolloutParent(at(path.join(dir, 'missing.jsonl')))).toBeUndefined()
  })
})
