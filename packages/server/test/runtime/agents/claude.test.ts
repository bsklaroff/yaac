import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { classifyClaudeTitle, getFirstUserMessage } from '#runtime/agents/claude'
import type { SandboxFile } from '#runtime/agents/sandbox-fs'

/** A file as the readers take it: its dir plus its name. */
const at = (file: string): SandboxFile => ({ slug: 'demo', dir: path.dirname(file), rel: path.basename(file) })

// Titles observed from live Claude Code: a running turn shows a spinner
// prefix, and every state waiting on the user shows ✳. The spinner glyphs
// vary by release (Braille in 2.1.226, circle phases ◐◑ from 2.1.228), so
// both must read as running.
describe('classifyClaudeTitle', () => {
  it('returns running for a Braille-spinner title (turn in flight)', () => {
    expect(classifyClaudeTitle('⠐ Create temporary marker file')).toBe('running')
    expect(classifyClaudeTitle('⠋ Fix the login bug')).toBe('running')
  })

  it('returns running across the whole Braille block', () => {
    // Accept the whole U+2800–U+28FF range.
    expect(classifyClaudeTitle('⠀ edge of block')).toBe('running')
    expect(classifyClaudeTitle('⣿ edge of block')).toBe('running')
  })

  it('returns running for a circle-phase spinner title (turn in flight)', () => {
    // Observed on 2.1.229: ◐/◑ for the whole turn, never Braille.
    expect(classifyClaudeTitle('◐ Review PR #115: retire legacy-compat paths')).toBe('running')
    expect(classifyClaudeTitle('◑ Review PR #115: retire legacy-compat paths')).toBe('running')
  })

  it('returns running across the whole circle-phase range', () => {
    // Accept all four phases (U+25D0–U+25D3), not just the two in use.
    expect(classifyClaudeTitle('◒ edge of range')).toBe('running')
    expect(classifyClaudeTitle('◓ edge of range')).toBe('running')
  })

  it('returns running for a bare spinner with trailing newline (display-message output)', () => {
    expect(classifyClaudeTitle('⠹ Summarize findings\n')).toBe('running')
    expect(classifyClaudeTitle('◐ Summarize findings\n')).toBe('running')
  })

  it('returns waiting for the idle ✳ title', () => {
    expect(classifyClaudeTitle('✳ Create temporary marker file')).toBe('waiting')
  })

  it('returns waiting for the fresh-boot title before any turn ran', () => {
    expect(classifyClaudeTitle('✳ Claude Code')).toBe('waiting')
  })

  it('returns waiting while a permission dialog is up', () => {
    // The transcript cannot show this: the blocked tool_use is not written
    // until answered.
    expect(classifyClaudeTitle('✳ Create temporary marker file')).toBe('waiting')
  })

  it('returns waiting for the tmux default title (claude has not set one)', () => {
    // Until claude sets a title, #{pane_title} is the hostname.
    expect(classifyClaudeTitle('yaac-yaac-ee9cb586-74d3-4a1f-9d1f-482839b26d70-5tfxq')).toBe('waiting')
  })

  it('returns waiting for an empty title', () => {
    expect(classifyClaudeTitle('')).toBe('waiting')
  })

  it('does not match the geometric glyphs bordering the circle phases', () => {
    // Claude Code uses nearby glyphs (●, ○, ◆, ◇) elsewhere.
    expect(classifyClaudeTitle('● Ran a command')).toBe('waiting')
    expect(classifyClaudeTitle('○ Pending step')).toBe('waiting')
    expect(classifyClaudeTitle('◆ Marker')).toBe('waiting')
    expect(classifyClaudeTitle('◔ Just past the phases')).toBe('waiting')
  })

  it('only matches the spinner at the first character', () => {
    expect(classifyClaudeTitle('✳ Fix ⠋ spinner rendering')).toBe('waiting')
    expect(classifyClaudeTitle('✳ Fix ◐ spinner rendering')).toBe('waiting')
    expect(classifyClaudeTitle(' ⠋ leading space')).toBe('waiting')
    expect(classifyClaudeTitle(' ◐ leading space')).toBe('waiting')
  })
})

describe('getFirstUserMessage', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-user-msg-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeEntry(entry: Record<string, unknown>): Promise<void> {
    return fs.appendFile(jsonlPath, JSON.stringify(entry) + '\n')
  }

  it('returns string content from first user message', async () => {
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'fix the login bug' } })
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getFirstUserMessage(at(jsonlPath))).toBe('fix the login bug')
  })

  it('returns text from content block array', async () => {
    await writeEntry({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'refactor the API' }] },
    })
    expect(await getFirstUserMessage(at(jsonlPath))).toBe('refactor the API')
  })

  it('skips a user entry with no text block, such as a tool result', async () => {
    await writeEntry({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'the real ask' } })
    expect(await getFirstUserMessage(at(jsonlPath))).toBe('the real ask')
  })

  it('returns undefined when no user messages exist', async () => {
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getFirstUserMessage(at(jsonlPath))).toBeUndefined()
  })

  it('returns undefined for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getFirstUserMessage(at(jsonlPath))).toBeUndefined()
  })

  it('returns undefined for missing file', async () => {
    expect(await getFirstUserMessage(at(path.join(tmpDir, 'nope.jsonl')))).toBeUndefined()
  })

  it('skips metadata and returns first user message', async () => {
    await writeEntry({ type: 'system' })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello world' } })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'second message' } })
    expect(await getFirstUserMessage(at(jsonlPath))).toBe('hello world')
  })

  it('finds the first user message beyond the first 8KB of the file', async () => {
    await writeEntry({ type: 'system', content: 'x'.repeat(12000) })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello world' } })

    expect(await getFirstUserMessage(at(jsonlPath))).toBe('hello world')
  })

  it('skips a session started with a slash command and returns the first real message', async () => {
    // What `/model` writes before the first real turn: three synthetic
    // type:'user' entries (an isMeta caveat, the command, its stdout).
    await writeEntry({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' },
    })
    await writeEntry({
      type: 'user',
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
      },
    })
    await writeEntry({
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>Set model to Fable 5</local-command-stdout>' },
    })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'fix the login bug' } })

    expect(await getFirstUserMessage(at(jsonlPath))).toBe('fix the login bug')
  })

  it('skips an isMeta user entry even without a command wrapper', async () => {
    await writeEntry({ type: 'user', isMeta: true, message: { role: 'user', content: 'synthetic preamble' } })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'real message' } })
    expect(await getFirstUserMessage(at(jsonlPath))).toBe('real message')
  })

  it('returns undefined when only command messages exist', async () => {
    await writeEntry({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' },
    })
    await writeEntry({
      type: 'user',
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    })
    expect(await getFirstUserMessage(at(jsonlPath))).toBeUndefined()
  })
})
