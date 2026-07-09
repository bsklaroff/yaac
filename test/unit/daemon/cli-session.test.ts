import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  createCliSessionRegistry,
  outputTail,
  presentableOutput,
  type CliSession,
} from '@/daemon/cli-session'

describe('output helpers', () => {
  it('outputTail joins the last non-empty lines', () => {
    expect(outputTail('a\n\n b \nc\nd\ne\n', 3)).toBe('c | d | e')
  })

  it('presentableOutput drops spinner frames, duplicate lines, and extra blanks', () => {
    const buf = 'Opening browser…\n✢\n*\n✻\n\n\n\nvisit: https://x\nvisit: https://x\nfollow the prompts\n'
    expect(presentableOutput(buf)).toBe('Opening browser…\n\nvisit: https://x\nfollow the prompts')
  })

  it('presentableOutput drops the paste-code prompt — the webapp has its own box', () => {
    expect(presentableOutput('visit: https://x\nPaste code here if prompted > ')).toBe('visit: https://x')
  })

  it('presentableOutput keeps text Ink appends after the paste-code prompt', () => {
    expect(presentableOutput('Paste code here if prompted > Login successful.\n')).toBe('Login successful.')
  })

  it('presentableOutput caps to the last maxChars', () => {
    expect(presentableOutput('abcdefgh', 4)).toBe('efgh')
  })
})

describe('cli-session registry', () => {
  const released: string[] = []
  const registry = createCliSessionRegistry<CliSession>({
    noun: 'test session',
    onRelease: (s) => released.push(s.view.id),
  })

  afterEach(() => {
    registry.clearAllForTests()
    released.length = 0
    vi.useRealTimers()
  })

  function start(id: string, tool: 'claude' | 'codex' = 'claude'): CliSession {
    const s = registry.create({ id, tool, status: 'running' }, 'Timed out.', {})
    s.proc = { kill: vi.fn() }
    return s
  }

  it('creates a running session pollable by id; unknown ids throw NOT_FOUND', () => {
    start('s1')
    expect(registry.getView('s1')).toMatchObject({ id: 's1', tool: 'claude', status: 'running' })
    expect(() => registry.getView('nope')).toThrow(/No test session "nope"/)
    expect(() => registry.getById('nope')).toThrow(/No test session "nope"/)
  })

  it('getView presents the ANSI-stripped, cleaned buffer as output', () => {
    const s = start('s1')
    registry.ingest(s, '\x1b[94mvisit: https://x\x1b[0m\n')
    registry.ingest(s, 'visit: https://x\n') // Ink re-render — deduped
    expect(registry.getView('s1').output).toBe('visit: https://x')
  })

  it('times out an unfinished session with the given error', () => {
    vi.useFakeTimers()
    const s = start('s1')
    vi.advanceTimersByTime(15 * 60 * 1000)
    expect(s.proc).toBeNull()
    expect(registry.getView('s1')).toMatchObject({ status: 'error', error: 'Timed out.' })
    expect(released).toEqual(['s1'])
  })

  it('finish kills the process, flips the view, and lingers before dropping', () => {
    vi.useFakeTimers()
    const s = start('s1')
    const kill = s.proc!.kill
    registry.finish(s, 'success')
    expect(kill).toHaveBeenCalled()
    expect(registry.getView('s1').status).toBe('success')
    expect(released).toEqual(['s1'])

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(() => registry.getView('s1')).toThrow(/No test session/)
  })

  it('liveForTool returns the still-running session for a tool only', () => {
    const claude = start('c1', 'claude')
    start('x1', 'codex')
    expect(registry.liveForTool('claude')).toBe(claude)
    registry.finish(claude, 'error', 'boom')
    expect(registry.liveForTool('claude')).toBeUndefined()
    expect(registry.liveForTool('codex')?.view.id).toBe('x1')
  })

  it('cancel forgets the session, releases it, and is idempotent', () => {
    const s = start('s1')
    const kill = s.proc!.kill
    registry.cancel('s1')
    expect(kill).toHaveBeenCalled()
    expect(() => registry.getView('s1')).toThrow(/No test session/)
    expect(released).toEqual(['s1'])
    registry.cancel('s1') // already gone — a no-op
    expect(released).toEqual(['s1'])
  })

  it('clearAllForTests drops everything without running onRelease', () => {
    start('s1')
    start('s2', 'codex')
    registry.clearAllForTests()
    expect(() => registry.getView('s1')).toThrow(/No test session/)
    expect(() => registry.getView('s2')).toThrow(/No test session/)
    expect(released).toEqual([])
  })
})
