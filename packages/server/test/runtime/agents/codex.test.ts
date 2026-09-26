import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  _resetCodexPosturesForTests,
  classifyCodexTitle,
  getCodexFirstUserMessage,
  getCodexPermissionMode,
} from '#runtime/agents/codex'

// Title fixtures below reproduce states observed against a live Codex
// session (codex-cli 0.142.4): a running turn animates a Braille spinner
// ahead of the project name; idle drops back to the bare project name;
// a user-blocked approval prompt swaps the spinner for a blinking
// "[ ! ] Action Required" prefix.
describe('classifyCodexTitle', () => {
  it('returns running for a Braille-spinner title (turn in flight)', () => {
    expect(classifyCodexTitle('⠴ workdir')).toBe('running')
    expect(classifyCodexTitle('⠋ yaac')).toBe('running')
  })

  it('returns running across the whole Braille block', () => {
    // The animation cycles through ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ — accept the full
    // U+2800–U+28FF range, including the endpoints.
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
    // Codex suppresses the spinner while blocked on user input and
    // instead blinks an Action Required prefix — both phases must
    // classify as waiting. This is the case the JSONL transcript could
    // not reliably detect.
    expect(classifyCodexTitle('[ ! ] Action Required workdir')).toBe('waiting')
    expect(classifyCodexTitle('[ . ] Action Required workdir')).toBe('waiting')
  })

  it('returns waiting for the tmux default title (codex has not set one)', () => {
    // Until a program emits an OSC title, #{pane_title} is the pod
    // hostname — a session still booting reads as waiting.
    expect(classifyCodexTitle('yaac-yaac-ee9cb586-74d3-4a1f-9d1f-482839b26d70-5tfxq')).toBe('waiting')
  })

  it('returns waiting for an empty title', () => {
    expect(classifyCodexTitle('')).toBe('waiting')
  })

  it('only matches the spinner at the first character', () => {
    // A project name that itself contains a Braille glyph must not
    // false-positive when the title has no leading spinner.
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
    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('returns undefined when no event_msg exists', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc' })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('returns undefined when file does not exist', async () => {
    expect(await getCodexFirstUserMessage(path.join(tmpDir, 'nonexistent.jsonl'))).toBeUndefined()
  })

  it('returns undefined for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getCodexFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('skips non-event_msg entries', async () => {
    await writeEntry({ type: 'session_start', session_id: 'abc' })
    await writeEntry({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })
    await writeEntry({ type: 'event_msg', payload: { type: 'user_message', message: 'second prompt' } })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('second prompt')
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
    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('fix the login bug')
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

    expect(await getCodexFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('ignores the legacy top-level event_msg message shape', async () => {
    await writeEntry({ type: 'event_msg', message: 'legacy prompt', images: [] })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('ignores non-user event_msg payloads', async () => {
    await writeEntry({ type: 'event_msg', payload: { type: 'agent_message', message: 'internal note' } })
    expect(await getCodexFirstUserMessage(jsonlPath)).toBeUndefined()
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
      expect((await getCodexPermissionMode(await rollout([turnContext(s)])))?.permissionMode).toBe(mode)
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
    await expect(getCodexPermissionMode(jsonl))
      .resolves.toEqual({ permissionMode: 'bypass', atMs: Date.parse('2026-09-24T20:21:41.151Z') })

    // Codex's own plan mode is only instructions to the model, over whatever
    // sandbox is in force, so it says nothing about the posture.
    await fs.appendFile(jsonl, JSON.stringify(applied({
      approval_policy: 'never', permission_profile: FULL, collaboration_mode: { mode: 'plan' },
    })) + '\n')
    expect((await getCodexPermissionMode(jsonl))?.permissionMode).toBe('bypass')
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
      expect((await getCodexPermissionMode(await rollout([turnContext(s)])))?.permissionMode).toBe(mode)
    }
  })

  // Settings nothing can be said about are the answer — not an older entry
  // that named one, which would claim a posture codex has since left.
  it('answers nothing for settings no posture stands for', async () => {
    const jsonl = await rollout([turnContext(), applied({ approval_policy: { granular: {} } })])
    await expect(getCodexPermissionMode(jsonl)).resolves.toBeUndefined()
  })

  it('reads nothing from a rollout that is not there', async () => {
    await expect(getCodexPermissionMode(path.join(dir, 'missing.jsonl'))).resolves.toBeUndefined()
  })
})
