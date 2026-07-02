import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

vi.mock('@/lib/k8s/exec', () => ({
  containerExec: vi.fn(),
}))

import {
  classifyClaudeTitle,
  getFirstUserMessage,
  getSessionClaudeStatus,
  evictClaudeStatusCache,
  _clearClaudeStatusCacheForTests,
} from '@/lib/session/claude-status'
import { containerExec } from '@/lib/k8s/exec'

const mockExec = vi.mocked(containerExec)

// Title fixtures below reproduce states observed against a live Claude
// Code session inside a session pod: a running turn animates a Braille
// spinner prefix; every user-blocked state (idle prompt, permission
// dialog, plan approval, AskUserQuestion) flips the prefix to ✳.
describe('classifyClaudeTitle', () => {
  it('returns running for a Braille-spinner title (turn in flight)', () => {
    expect(classifyClaudeTitle('⠐ Create temporary marker file')).toBe('running')
    expect(classifyClaudeTitle('⠋ Fix the login bug')).toBe('running')
  })

  it('returns running across the whole Braille block', () => {
    // The animation cycles through arbitrary Braille patterns — accept
    // the full U+2800–U+28FF range, including the endpoints.
    expect(classifyClaudeTitle('⠀ edge of block')).toBe('running')
    expect(classifyClaudeTitle('⣿ edge of block')).toBe('running')
  })

  it('returns running for a bare spinner with trailing newline (display-message output)', () => {
    expect(classifyClaudeTitle('⠹ Summarize findings\n')).toBe('running')
  })

  it('returns waiting for the idle ✳ title', () => {
    expect(classifyClaudeTitle('✳ Create temporary marker file')).toBe('waiting')
  })

  it('returns waiting for the fresh-boot title before any turn ran', () => {
    expect(classifyClaudeTitle('✳ Claude Code')).toBe('waiting')
  })

  it('returns waiting while a permission dialog is up', () => {
    // Observed live: the instant the Bash permission dialog appears the
    // title flips from "⠂ Create temporary marker file" to ✳. Same for
    // trust/onboarding dialogs. This is the case the JSONL transcript
    // cannot detect (the blocking tool_use isn't persisted until
    // answered), so it must classify as waiting here.
    expect(classifyClaudeTitle('✳ Create temporary marker file')).toBe('waiting')
  })

  it('returns waiting for the tmux default title (claude has not set one)', () => {
    // Until a program emits an OSC title, #{pane_title} is the pod
    // hostname — a session still booting reads as waiting.
    expect(classifyClaudeTitle('yaac-yaac-ee9cb586-74d3-4a1f-9d1f-482839b26d70-5tfxq')).toBe('waiting')
  })

  it('returns waiting for an empty title', () => {
    expect(classifyClaudeTitle('')).toBe('waiting')
  })

  it('only matches the spinner at the first character', () => {
    // A task summary that itself contains a Braille glyph must not
    // false-positive when the leading ✳ marks the session as idle.
    expect(classifyClaudeTitle('✳ Fix ⠋ spinner rendering')).toBe('waiting')
    expect(classifyClaudeTitle(' ⠋ leading space')).toBe('waiting')
  })
})

describe('getSessionClaudeStatus', () => {
  beforeEach(() => {
    _clearClaudeStatusCacheForTests()
    mockExec.mockReset()
  })

  function mockTitle(title: string): void {
    // display-message -p terminates its output with a newline.
    mockExec.mockResolvedValue({ stdout: `${title}\n`, stderr: '' })
  }

  it('returns running when the title carries the Braille spinner', async () => {
    mockTitle('⠙ Refactor the API')
    await expect(getSessionClaudeStatus('p', 's-run', 'c-run')).resolves.toBe('running')
  })

  it('returns waiting when the title shows the idle ✳ prefix', async () => {
    mockTitle('✳ Refactor the API')
    await expect(getSessionClaudeStatus('p', 's-wait', 'c-wait')).resolves.toBe('waiting')
  })

  it('returns waiting when the title probe fails (pod not ready)', async () => {
    mockExec.mockRejectedValue(new Error('no such pod'))
    await expect(getSessionClaudeStatus('p', 's-absent', 'c-absent')).resolves.toBe('waiting')
  })

  it('queries the pane title of the named job\'s claude pane', async () => {
    mockTitle('⠙ Working')
    await getSessionClaudeStatus('p', 's-cmd', 'yaac-proj-cmd')
    expect(mockExec).toHaveBeenCalledTimes(1)
    const [jobName, cmd] = mockExec.mock.calls[0]
    expect(jobName).toBe('yaac-proj-cmd')
    expect(cmd).toContain("display-message -p -t yaac:claude.0 '#{pane_title}'")
  })

  it('serves repeat calls from the TTL cache without re-invoking kubectl', async () => {
    mockTitle('✳ Idle')
    expect(await getSessionClaudeStatus('p', 's-cache', 'c-cache')).toBe('waiting')
    // A second call within the TTL must NOT exec again — verify
    // by switching the mock to throw; if the cache were bypassed the
    // call would now return 'waiting' for a different reason but
    // would also bump the mock counter.
    mockExec.mockRejectedValue(new Error('should not be called'))
    expect(await getSessionClaudeStatus('p', 's-cache', 'c-cache')).toBe('waiting')
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    mockTitle('⠹ Working')
    const p1 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    const p2 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    const p3 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['running', 'running', 'running'])
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('caches per (slug, sid), not globally', async () => {
    mockExec.mockImplementation((jobName: string) => {
      if (jobName.includes('c-A')) return Promise.resolve({ stdout: '⠧ Working\n', stderr: '' })
      return Promise.resolve({ stdout: '✳ Idle\n', stderr: '' })
    })
    expect(await getSessionClaudeStatus('p', 's-A', 'c-A')).toBe('running')
    expect(await getSessionClaudeStatus('p', 's-B', 'c-B')).toBe('waiting')
  })

  it('evictClaudeStatusCache clears the entry for that session', async () => {
    mockTitle('✳ Idle')
    expect(await getSessionClaudeStatus('p', 's-evict', 'c-evict')).toBe('waiting')

    evictClaudeStatusCache('p', 's-evict')

    // Cache cleared — a fresh probe re-runs the title query.
    mockTitle('⠛ Working')
    expect(await getSessionClaudeStatus('p', 's-evict', 'c-evict')).toBe('running')
    expect(mockExec).toHaveBeenCalledTimes(2)
  })
})

describe('evictClaudeStatusCache', () => {
  it('is exported as a function', () => {
    expect(typeof evictClaudeStatusCache).toBe('function')
  })
})

describe('_clearClaudeStatusCacheForTests', () => {
  it('is exported as a function', () => {
    expect(typeof _clearClaudeStatusCacheForTests).toBe('function')
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
    expect(await getFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('returns text from content block array', async () => {
    await writeEntry({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'refactor the API' }] },
    })
    expect(await getFirstUserMessage(jsonlPath)).toBe('refactor the API')
  })

  it('returns undefined when no user messages exist', async () => {
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('returns undefined for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('returns undefined for missing file', async () => {
    expect(await getFirstUserMessage(path.join(tmpDir, 'nope.jsonl'))).toBeUndefined()
  })

  it('skips metadata and returns first user message', async () => {
    await writeEntry({ type: 'system' })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello world' } })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'second message' } })
    expect(await getFirstUserMessage(jsonlPath)).toBe('hello world')
  })

  it('finds the first user message beyond the first 8KB of the file', async () => {
    await writeEntry({ type: 'system', content: 'x'.repeat(12000) })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello world' } })

    expect(await getFirstUserMessage(jsonlPath)).toBe('hello world')
  })
})
