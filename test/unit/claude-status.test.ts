import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  classifyClaudePane,
  getFirstUserMessage,
  getSessionClaudeStatus,
  evictClaudeStatusCache,
  _clearClaudeStatusCacheForTests,
} from '@/lib/session/claude-status'
import {
  setDataDir,
  sessionTmuxDir,
  sessionTmuxPaneLogPath,
} from '@/lib/project/paths'

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
})

describe('getSessionClaudeStatus', () => {
  let dataDir: string

  beforeEach(async () => {
    _clearClaudeStatusCacheForTests()
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claude-status-'))
    setDataDir(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  async function writePane(slug: string, sid: string, content: string): Promise<void> {
    await fs.mkdir(sessionTmuxDir(slug, sid), { recursive: true })
    await fs.writeFile(sessionTmuxPaneLogPath(slug, sid), content)
  }

  async function readPane(slug: string, sid: string): Promise<string> {
    return fs.readFile(sessionTmuxPaneLogPath(slug, sid), 'utf8')
  }

  it('returns running when the pane log shows the interrupt hint', async () => {
    await writePane('p', 's-run', 'doing things… (esc to interrupt)')
    await expect(getSessionClaudeStatus('p', 's-run', 'c-run')).resolves.toBe('running')
  })

  it('returns waiting when the pane log lacks the interrupt hint', async () => {
    await writePane('p', 's-wait', '❯ ')
    await expect(getSessionClaudeStatus('p', 's-wait', 'c-wait')).resolves.toBe('waiting')
  })

  it('returns waiting when the pane log file does not exist yet', async () => {
    await expect(getSessionClaudeStatus('p', 's-absent', 'c-absent')).resolves.toBe('waiting')
  })

  it('truncates the pane log after a successful read', async () => {
    await writePane('p', 's-trunc', 'some pane content')
    await getSessionClaudeStatus('p', 's-trunc', 'c-trunc')
    await expect(readPane('p', 's-trunc')).resolves.toBe('')
  })

  it('reads only the trailing window of a large pane log', async () => {
    // Pad the front of the file with content that does NOT match, and
    // put the interrupt hint at the very end. The probe should still
    // detect "running" because it reads from the tail.
    const padding = 'x'.repeat(20000)
    await writePane('p', 's-tail', `${padding}\nfinally: esc to interrupt`)
    await expect(getSessionClaudeStatus('p', 's-tail', 'c-tail')).resolves.toBe('running')
  })

  it('serves repeat calls from the TTL cache without re-reading', async () => {
    await writePane('p', 's-cache', '❯ ')
    expect(await getSessionClaudeStatus('p', 's-cache', 'c-cache')).toBe('waiting')
    // The file was truncated; without caching, a subsequent call would
    // see an empty file and re-classify (still 'waiting' incidentally,
    // but the file would also stay empty). Write 'running' content and
    // verify the cached 'waiting' wins.
    await writePane('p', 's-cache', 'esc to interrupt')
    expect(await getSessionClaudeStatus('p', 's-cache', 'c-cache')).toBe('waiting')
  })

  it('coalesces concurrent callers onto a single in-flight probe', async () => {
    await writePane('p', 's-coalesce', 'esc to interrupt')
    const p1 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    const p2 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    const p3 = getSessionClaudeStatus('p', 's-coalesce', 'c1')
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['running', 'running', 'running'])
    // The shared probe means we read+truncate exactly once.
    await expect(readPane('p', 's-coalesce')).resolves.toBe('')
  })

  it('caches per (slug, sid), not globally', async () => {
    await writePane('p', 's-A', 'esc to interrupt')
    await writePane('p', 's-B', '❯ ')
    expect(await getSessionClaudeStatus('p', 's-A', 'c-A')).toBe('running')
    expect(await getSessionClaudeStatus('p', 's-B', 'c-B')).toBe('waiting')
  })

  it('evictClaudeStatusCache clears the entry for that session', async () => {
    await writePane('p', 's-evict', '❯ ')
    expect(await getSessionClaudeStatus('p', 's-evict', 'c-evict')).toBe('waiting')

    evictClaudeStatusCache('p', 's-evict')

    // Cache cleared — write 'running' content and confirm the next
    // probe re-reads it.
    await writePane('p', 's-evict', 'esc to interrupt')
    expect(await getSessionClaudeStatus('p', 's-evict', 'c-evict')).toBe('running')
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
