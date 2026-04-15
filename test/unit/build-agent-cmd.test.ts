import { describe, it, expect } from 'vitest'
import { buildAgentCmd } from '@/commands/session-create'

describe('buildAgentCmd', () => {
  describe('codex tool', () => {
    it('passes prompt as a positional argument after --', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', '', 'fix the bug')
      expect(cmd).toBe('codex --yolo -- "fix the bug"')
    })

    it('omits prompt when not provided', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', '')
      expect(cmd).toBe('codex --yolo')
    })

    it('includes add-dir flags', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', '--add-dir /add-dir/tmp', 'hello')
      expect(cmd).toBe('codex --yolo --add-dir /add-dir/tmp -- "hello"')
    })

    it('escapes single quotes in prompt', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', '', "it's broken")
      expect(cmd).toContain('-- "it\'\\\'\'s broken"')
    })
  })

  describe('claude tool', () => {
    it('passes prompt with -p flag', () => {
      const cmd = buildAgentCmd('claude', 'sess-1', '', 'fix the bug')
      expect(cmd).toBe('claude --dangerously-skip-permissions --session-id sess-1 -p fix the bug')
    })

    it('omits prompt when not provided', () => {
      const cmd = buildAgentCmd('claude', 'sess-1', '')
      expect(cmd).toBe('claude --dangerously-skip-permissions --session-id sess-1')
    })

    it('includes session-id and add-dir flags', () => {
      const cmd = buildAgentCmd('claude', 'abc', '--add-dir /add-dir/tmp', 'hello')
      expect(cmd).toBe('claude --dangerously-skip-permissions --session-id abc --add-dir /add-dir/tmp -p hello')
    })
  })
})
