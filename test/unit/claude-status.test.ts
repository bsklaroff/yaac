import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

vi.mock('@/lib/container/runtime', () => ({
  shellPodmanWithRetry: vi.fn(),
}))

import {
  classifyClaudePane,
  getFirstUserMessage,
  getSessionClaudeStatus,
  evictClaudeStatusCache,
  _clearClaudeStatusCacheForTests,
} from '@/lib/session/claude-status'
import { shellPodmanWithRetry } from '@/lib/container/runtime'

const mockExec = vi.mocked(shellPodmanWithRetry)

describe('classifyClaudePane', () => {
  it('returns running when the pane shows "esc to interrupt"', () => {
    const pane = [
      '● Let me run the tests.',
      '',
      '  ⎿  Running…',
      '',
      '✳ Brewing… (12s · ↓ 340 tokens · esc to interrupt)',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('running')
  })

  it('returns running when the pane shows "ctrl+c to interrupt"', () => {
    const pane = [
      '● Working on it.',
      '',
      '* (ctrl+c to interrupt)',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('running')
  })

  it('returns running when the bottom bar embeds the interrupt hint', () => {
    // Claude Code's newer TUI moves the interrupt hint into the
    // status bar alongside the bypass-permissions toggle and the
    // tasks panel shortcut. `capture-pane -p` renders the bar as
    // a single visible line, separators and all.
    const pane = [
      '● Working on it.',
      '',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ctrl+t to hide tasks',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('running')
  })

  it('returns running when a subagent task list sits below the interrupt hint', () => {
    // While running subagents Claude Code renders a task list at the
    // very bottom of the pane, pushing the spinner/interrupt-hint line
    // up several rows — out of reach of a tight 3-row footer window.
    const pane = [
      '● Delegating to subagents.',
      '',
      '✳ Orchestrating… (45s · ↑ 2.1k tokens · esc to interrupt)',
      '  ├─ Explore(search status code) running… (12s)',
      '  ├─ Explore(map test files) running… (9s)',
      '  ├─ general-purpose(audit detection) running… (30s)',
      '  └─ claude(write up findings) running… (4s)',
      '',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('running')
  })

  it('returns waiting for the idle ready prompt', () => {
    const pane = [
      '● Done.',
      '',
      '─────────────────────────',
      '❯ ',
      '─────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('waiting')
  })

  it('returns waiting for the AskUserQuestion selector UI', () => {
    const pane = [
      '● Before I draft the plan I want to pin down a few design choices:',
      '─────────────────────────',
      '←  ☐ Selection  ☐ Container  ☐ V1 scope  ✔ Submit  →',
      '',
      'How should the user pick which agent backend to use?',
      '',
      '❯ 1. Per-session picker at creation',
      '  2. Global env flag only',
      '  3. Per-project setting',
      '  4. Type something.',
      '─────────────────────────',
      '  5. Chat about this',
      '  6. Skip interview and plan immediately',
      '',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('waiting')
  })

  it('returns waiting for the ExitPlanMode approval UI', () => {
    const pane = [
      ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '',
      ' ❯ 1. Yes, and use auto mode',
      '   2. Yes, manually approve edits',
      '   3. No, refine with Ultraplan on Claude Code on the web',
      '   4. Tell Claude what to change',
      '      shift+tab to approve with this feedback',
      '',
      ' ctrl-g to edit in Nvim · ~/.claude/plans/my-plan.md',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('waiting')
  })

  it('returns waiting for a [y/n] permission prompt', () => {
    const pane = [
      '● Bash(rm -rf node_modules)',
      'Delete files? [y/n]',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('waiting')
  })

  it('returns waiting for an empty pane', () => {
    expect(classifyClaudePane('')).toBe('waiting')
  })

  it('returns waiting for an unrecognized pane', () => {
    expect(classifyClaudePane('some arbitrary text with nothing special')).toBe('waiting')
  })

  it('matches the interrupt hint case-insensitively', () => {
    expect(classifyClaudePane('ESC TO INTERRUPT')).toBe('running')
    expect(classifyClaudePane('Ctrl+C To Interrupt')).toBe('running')
  })

  it('does not match partial phrases that lack "to interrupt"', () => {
    // The user's own prompt mentioning esc or ctrl+c should not be
    // misread as Claude actively working.
    expect(classifyClaudePane('please use esc when done')).toBe('waiting')
    expect(classifyClaudePane('I pressed ctrl+c earlier')).toBe('waiting')
  })

  it('tolerates extra whitespace between the modifier and "to interrupt"', () => {
    expect(classifyClaudePane('esc   to   interrupt')).toBe('running')
  })

  it('ignores the interrupt hint when it appears in transcript history above the footer', () => {
    // Real regression: the pane is 200 rows tall and transcript history
    // scrolls up but stays visible. An assistant turn that quoted the
    // phrase "esc to interrupt" (in a Web Search query, a discussion of
    // this regex, etc.) caused the whole-pane scan to false-positive as
    // 'running' while the live status bar was actually the idle one.
    const padding: string[] = Array.from({ length: 20 }, () => '')
    const pane = [
      '● Web Search("opencode TUI status spinner \"esc to interrupt\" indicator")',
      '  ⎿  Did 1 search in 10s',
      '',
      '● The strings come from opencode\'s dev branch — same fragility',
      '  class as claude-status\'s ctrl+c/esc to interrupt regex.',
      '',
      ...padding,
      '──────────────────────────',
      '❯ ',
      '──────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')
    expect(classifyClaudePane(pane)).toBe('waiting')
  })
})

describe('getSessionClaudeStatus', () => {
  beforeEach(() => {
    _clearClaudeStatusCacheForTests()
    mockExec.mockReset()
  })

  function mockPane(content: string): void {
    mockExec.mockResolvedValue({ stdout: content, stderr: '' })
  }

  it('returns running when capture-pane includes the interrupt hint', async () => {
    mockPane('doing things… (esc to interrupt)')
    await expect(getSessionClaudeStatus('p', 's-run', 'c-run')).resolves.toBe('running')
  })

  it('returns waiting when capture-pane lacks the interrupt hint', async () => {
    mockPane('❯ ')
    await expect(getSessionClaudeStatus('p', 's-wait', 'c-wait')).resolves.toBe('waiting')
  })

  it('returns waiting when capture-pane fails (container not ready)', async () => {
    mockExec.mockRejectedValue(new Error('no such container'))
    await expect(getSessionClaudeStatus('p', 's-absent', 'c-absent')).resolves.toBe('waiting')
  })

  it('invokes capture-pane against the named container and claude pane', async () => {
    mockPane('esc to interrupt')
    await getSessionClaudeStatus('p', 's-cmd', 'yaac-proj-cmd')
    expect(mockExec).toHaveBeenCalledTimes(1)
    const cmd = mockExec.mock.calls[0][0]
    expect(cmd).toContain('podman exec yaac-proj-cmd')
    expect(cmd).toContain('capture-pane -pJ -t yaac:claude.0')
  })

  it('serves repeat calls from the TTL cache without re-invoking podman', async () => {
    mockPane('❯ ')
    expect(await getSessionClaudeStatus('p', 's-cache', 'c-cache')).toBe('waiting')
    // A second call within the TTL must NOT call podman again — verify
    // by switching the mock to throw; if the cache were bypassed the
    // call would now return 'waiting' for a different reason but
    // would also bump the mock counter.
    mockExec.mockRejectedValue(new Error('should not be called'))
    expect(await getSessionClaudeStatus('p', 's-cache', 'c-cache')).toBe('waiting')
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    mockPane('esc to interrupt')
    const p1 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    const p2 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    const p3 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['running', 'running', 'running'])
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('caches per (slug, sid), not globally', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('c-A')) return Promise.resolve({ stdout: 'esc to interrupt', stderr: '' })
      return Promise.resolve({ stdout: '❯ ', stderr: '' })
    })
    expect(await getSessionClaudeStatus('p', 's-A', 'c-A')).toBe('running')
    expect(await getSessionClaudeStatus('p', 's-B', 'c-B')).toBe('waiting')
  })

  it('evictClaudeStatusCache clears the entry for that session', async () => {
    mockPane('❯ ')
    expect(await getSessionClaudeStatus('p', 's-evict', 'c-evict')).toBe('waiting')

    evictClaudeStatusCache('p', 's-evict')

    // Cache cleared — a fresh probe re-runs capture-pane.
    mockPane('esc to interrupt')
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
