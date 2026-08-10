import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  classifyCodexTitle,
  getCodexFirstUserMessage,
  removeLegacyCodexHook,
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

const YAAC_HOOK_COMMAND = '/home/yaac/.codex/.yaac-hook.sh'

interface HookEntry { type: string; command: string; timeout?: number }
interface HookMatcher { matcher: string; hooks: HookEntry[] }
interface HooksFile { hooks: Record<string, HookMatcher[]> }

const yaacMatcher: HookMatcher = {
  matcher: '*',
  hooks: [{ type: 'command', command: YAAC_HOOK_COMMAND, timeout: 10 }],
}

describe('removeLegacyCodexHook', () => {
  let tmpDir: string
  const hooksPath = (): string => path.join(tmpDir, 'hooks.json')
  const scriptPath = (): string => path.join(tmpDir, '.yaac-hook.sh')

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hooks-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('deletes the legacy .yaac-hook.sh script', async () => {
    await fs.writeFile(scriptPath(), '#!/bin/sh\n')
    await removeLegacyCodexHook(tmpDir)
    await expect(fs.access(scriptPath())).rejects.toThrow()
  })

  it('removes the yaac SessionStart entry and drops the empty key', async () => {
    const existing: HooksFile = { hooks: { SessionStart: [yaacMatcher] } }
    await fs.writeFile(hooksPath(), JSON.stringify(existing))

    await removeLegacyCodexHook(tmpDir)
    const parsed = JSON.parse(await fs.readFile(hooksPath(), 'utf8')) as HooksFile
    expect(parsed.hooks.SessionStart).toBeUndefined()
  })

  it('preserves other user hooks while removing only the yaac entry', async () => {
    const other: HookMatcher = {
      matcher: '*',
      hooks: [{ type: 'command', command: '/some/other/hook.sh', timeout: 30 }],
    }
    const existing: HooksFile = {
      hooks: {
        SessionStart: [other, yaacMatcher],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/another/hook.sh' }] }],
      },
    }
    await fs.writeFile(hooksPath(), JSON.stringify(existing))

    await removeLegacyCodexHook(tmpDir)
    const parsed = JSON.parse(await fs.readFile(hooksPath(), 'utf8')) as HooksFile

    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('/some/other/hook.sh')
    expect(parsed.hooks.PostToolUse).toHaveLength(1)
  })

  it('leaves hooks.json untouched when it has no yaac entry', async () => {
    const existing: HooksFile = {
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: '/keep.sh' }] }] },
    }
    await fs.writeFile(hooksPath(), JSON.stringify(existing) + '\n')
    const before = await fs.readFile(hooksPath(), 'utf8')

    await removeLegacyCodexHook(tmpDir)
    expect(await fs.readFile(hooksPath(), 'utf8')).toBe(before)
  })

  it('is a no-op when no hooks.json exists', async () => {
    await expect(removeLegacyCodexHook(tmpDir)).resolves.toBeUndefined()
    await expect(fs.access(hooksPath())).rejects.toThrow()
  })

  it('ignores an unreadable hooks.json without throwing', async () => {
    await fs.writeFile(hooksPath(), 'not valid json')
    await expect(removeLegacyCodexHook(tmpDir)).resolves.toBeUndefined()
  })
})
